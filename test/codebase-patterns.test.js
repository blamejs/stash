// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
/**
 * codebase-patterns -- automated grep gates for code-shape bug classes.
 *
 * The spec's load-bearing prohibitions (SPEC.md 1, 2.1, 3, 4.3, 10, 13.1)
 * are properties of the SHAPE of the source, not the behaviour of one
 * primitive, so a unit test cannot hold them. Each is encoded here as a
 * scan over the source tree so a regression is caught at commit time
 * rather than in review. A violation produces a `file:line: text` line in
 * the failing assertion message; each detector is its own node:test case.
 *
 * Exceptions are documented at the violation site, not here. Two shapes:
 *
 *   1. File-level header within the first 50 lines:
 *        // codebase-patterns:allow-file <class> -- <reason>
 *      Skips every match for that class in the file.
 *
 *   2. Per-line inline marker on the same line or up to two lines above:
 *        ... // allow:<class> -- <reason>
 *      Skips that single match.
 *
 * Both forms name a REGISTERED allow-class (see VALID_ALLOW_CLASSES); a
 * typo'd class suppresses nothing, and the marker-audit test rejects any
 * marker naming an unregistered class.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { freshScratchDir } from "./_scratch.js";
import { DIGESTS } from "../src/digest.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// This file names detector tokens in its own regexes and registry; the
// detectors that scan test/ skip it by relative path.
const SELF = "test/codebase-patterns.test.js";

// ---------------------------------------------------------------------------
// File-tree walkers
// ---------------------------------------------------------------------------

// A product walk (src/, test/, scripts/) scans EVERY subdirectory except
// node_modules and .git -- those are structurally never first-party source.
// Asset/vendor/dot-directory skips exist only for the example app
// (`skipAssetDirs`): applying them to a product tree would let a new
// src/public/ or src/vendor/ module ship in the tarball while sitting
// outside every detector's view.
function _walk(dir, files, opts) {
  files = files || [];
  const base = path.basename(dir);
  if (base === "node_modules" || base === ".git") return files;
  if (opts && opts.skipAssetDirs &&
      (base === "public" || base === "vendor" || base.startsWith("."))) {
    return files;
  }
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return files; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) _walk(full, files, opts);
    else if (/\.js$/.test(entry.name)) files.push(full);
  }
  return files;
}

function _relPath(absPath) {
  return path.relative(REPO_ROOT, absPath).replace(/\\/g, "/");
}

function _srcFiles() { return _walk(path.join(REPO_ROOT, "src")); }
function _testFiles() { return _walk(path.join(REPO_ROOT, "test")); }
function _scriptFiles() { return _walk(path.join(REPO_ROOT, "scripts")); }
function _wikiFiles() { return _walk(path.join(REPO_ROOT, "examples", "wiki"), [], { skipAssetDirs: true }); }
function _allJsFiles() {
  const seen = new Set();
  const out = [];
  for (const f of _srcFiles().concat(_testFiles(), _scriptFiles(), _wikiFiles())) {
    const rel = _relPath(f);
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(f);
  }
  return out;
}

function _read(absPath) {
  try { return fs.readFileSync(absPath, "utf8"); }
  catch { return ""; }
}

// ---------------------------------------------------------------------------
// Walker self-tests -- every detector above trusts _walk's output, so the
// walk itself is pinned: a skip rule that swallows a real source directory
// silently blinds EVERY detector at once, and an empty walk greens every
// scan vacuously.
// ---------------------------------------------------------------------------

test("file-walk contract -- a product walk descends into every subdirectory", (t) => {
  // reason: a violation in a subdirectory the walk skips is invisible to
  // every detector while still shipping in the tarball (package.json packs
  // src/ recursively). Only node_modules and .git are structurally never
  // first-party source; asset/vendor skips apply solely to the example app.
  const root = freshScratchDir("walk-contract");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ["sub", "public", "vendor", ".hidden", "node_modules", ".git"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "probe.js"), "export default 1;\n");
  }
  const names = (files) => files.map((f) => path.relative(root, f).replace(/\\/g, "/")).sort();

  assert.deepEqual(
    names(_walk(root)),
    [".hidden/probe.js", "public/probe.js", "sub/probe.js", "vendor/probe.js"],
    "product walk must scan every subdirectory except node_modules/.git"
  );
  assert.deepEqual(
    names(_walk(root, [], { skipAssetDirs: true })),
    ["sub/probe.js"],
    "asset-mode walk (example app) skips public/, vendor/, and dot-directories"
  );
});

test("file-walk floor -- every scanned family finds source files", () => {
  // reason: a renamed or relocated tree makes every walk return [], and
  // zero matches reads as zero violations -- the gate greens with nothing
  // scanned. Each family the detectors run over must be non-empty.
  assert.ok(_srcFiles().length > 0, "src/ walk found no files -- every src detector is vacuous");
  assert.ok(_testFiles().length > 0, "test/ walk found no files");
  assert.ok(_scriptFiles().length > 0, "scripts/ walk found no files");
  assert.ok(_wikiFiles().length > 0, "examples/wiki walk found no files");
});

// Split content into lines, tolerant of CRLF vs LF.
function _lines(content) { return content.split(/\r?\n/); }

function _lineOfIndex(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

// ---------------------------------------------------------------------------
// Source stripping
// ---------------------------------------------------------------------------

// Blank a matched region, preserving its newlines so line numbers computed
// on the stripped subject agree with the raw file.
function _blank(match) { return match.replace(/[^\n]/g, " "); }

// Strip `//` line comments and `/* */` block comments, keeping string
// literals (an import specifier is a string literal, and the sandbox scan
// must still see it). The `[^:]` guard keeps a `://` inside a URL intact.
function _stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, _blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, function (m, pre) { return pre + _blank(m.slice(pre.length)); });
}

// Strip comments AND string literals so a structural scan does not fire on
// prose in a docstring or a token that only appears inside a quoted
// message. Regex literals are NOT stripped.
function _stripCommentsAndLiterals(content) {
  return _stripComments(content)
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, _blank);
}

// ---------------------------------------------------------------------------
// Allow-marker filtering
// ---------------------------------------------------------------------------

// Every `// allow:<class>` suppression marker must name a REGISTERED
// detector allow-class. A typo'd or stale class suppresses NOTHING -- the
// detector it claims to silence does not exist -- so the violation ships
// unflagged. When you add a detector with a new allow-class, register it
// here so the marker-audit gate accepts it.
const VALID_ALLOW_CLASSES = {
  "guard-shape-reinlined": 1,
  "validator-shape-reinlined": 1,
  "forbidden-crypto-token": 1,
  "digest-algo-hardcode": 1,
  "prototype-key-confusion": 1,
  "sandbox-widening-import": 1,
  "permission-probe-branch": 1,
  "error-event-emit": 1,
  "emit-outside-policy": 1,
  "capability-in-error-message": 1,
  "catch-return-swallow": 1,
  "fail-open-verify": 1,
  "non-ascii-source": 1,
  "spdx-header": 1,
  "defer-marker": 1,
  "ai-attribution": 1,
  "raw-time-scale-literal": 1,
  "inline-dynamic-import": 1,
  "dead-underscore-function": 1,
  "unimported-builtin-call": 1,
  "path-reresolved-read": 1,
  "npm-shim-bare-spawn": 1,
  "constant-time-compare-short-circuited": 1,
  "wiki-port-cross-artifact-drift": 1,
  "wiki-runtime-file-uncopied": 1,
  "unretried-fs-mutation": 1,
};

// Drop matches suppressed by a file-level
// `codebase-patterns:allow-file <class>` header (first 50 lines) or a
// per-line `allow:<class>` marker on the match line or up to two lines
// above it.
function _filterMarkers(matches, allowClass) {
  const fileCache = new Map();
  const fileAllowCache = new Map();
  function _readContext(file) {
    if (!fileCache.has(file)) {
      fileCache.set(file, _lines(_read(path.resolve(REPO_ROOT, file))));
    }
    return fileCache.get(file);
  }
  function _hasFileAllow(file) {
    if (fileAllowCache.has(file)) return fileAllowCache.get(file);
    const head = _readContext(file).slice(0, 50);
    const re = new RegExp("codebase-patterns:allow-file\\s+" + allowClass + "\\b");
    const found = head.some((l) => re.test(l));
    fileAllowCache.set(file, found);
    return found;
  }
  function _hasLineAllow(file, lineNum) {
    const lines = _readContext(file);
    if (!lines.length) return false;
    const re = new RegExp("allow:" + allowClass + "\\b");
    return re.test(lines[lineNum - 1] || "") ||
           re.test(lines[lineNum - 2] || "") ||
           re.test(lines[lineNum - 3] || "");
  }
  return matches.filter((m) => !_hasFileAllow(m.file) && !_hasLineAllow(m.file, m.line));
}

// ---------------------------------------------------------------------------
// Violation reporting
// ---------------------------------------------------------------------------

// One assertion per detector: zero matches, with every violation listed as
// `file:line: text` in the failure message so the author fixes from the
// message alone.
function _report(label, matches) {
  const detail = matches
    .map((m) => "  " + m.file + ":" + m.line + ": " + String(m.content).slice(0, 160))
    .join("\n");
  assert.equal(
    matches.length, 0,
    label + " -- " + matches.length + " violation(s):\n" + detail
  );
}

// Scan a file set line by line against a regex. `prepare` (optional) maps
// raw content to the scan subject with identical line numbering (the
// strippers replace, never delete lines).
function _scanLines(files, regex, opts) {
  opts = opts || {};
  const matches = [];
  for (const file of files) {
    const rel = _relPath(file);
    if (opts.skipSelf && rel === SELF) continue;
    const raw = _read(file);
    const subject = opts.prepare ? opts.prepare(raw) : raw;
    const rawLines = _lines(raw);
    const lines = _lines(subject);
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push({ file: rel, line: i + 1, content: (rawLines[i] || lines[i]).trim() });
      }
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// (1) forbidden-crypto-token -- SPEC.md 1 / 13.1 invariant 1
// ---------------------------------------------------------------------------

test("forbidden-crypto-token -- no cipher machinery, sqlite, or password surface in src/", () => {
  // reason: the store's guarantee is architectural, not behavioural -- there
  // is nowhere in the source for a key to live. A cipher import (even the
  // legacy createCipher/createDecipher names), a node:sqlite index (which
  // bypasses the permission model's filesystem gate), or any password
  // surface would turn "cannot decrypt" back into "chooses not to". The
  // scan is RAW source, comments included: a commented-out cipher call is
  // still a hole being sketched. Token list is concatenated so this gate
  // file never matches itself.
  const tokens = [
    "createCiph" + "eriv",
    "createDeciph" + "eriv",
    "createCiph" + "er\\b",
    "createDeciph" + "er\\b",
    "node:sql" + "ite",
    "pass" + "word",
  ];
  const re = new RegExp(tokens.join("|"), "i");
  let bad = _scanLines(_srcFiles(), re);
  bad = _filterMarkers(bad, "forbidden-crypto-token");
  _report("SPEC.md 13.1: zero hits for cipher / sqlite / password tokens in src/ (raw, comments included)", bad);
});

// ---------------------------------------------------------------------------
// (1a) digest-algo-hardcode -- src/digest.js owns the algorithm set
// ---------------------------------------------------------------------------

test("digest-algo-hardcode -- no algorithm literal outside the digest registry", () => {
  // reason: src/digest.js is the ONE place a digest algorithm is named as a
  // code token -- the registry rows, the createHash factory, and the
  // "<algo>:<hex>" stored form all derive from it, and a read verifies with
  // the algorithm the entry names for ITSELF (SPEC.md 5). A `createHash("sha256")`
  // call or a "<algo>:" stored-digest prefix LITERAL anywhere else in src/
  // re-inlines that set: it pins one algorithm where the entry's own must
  // decide, so an entry written under sha3-512 would be hashed or verified with
  // the wrong function -- a silent integrity hole. The algorithm names are read
  // OFF the registry (DIGESTS) at scan time, so a new row extends the gate with
  // no edit here; comments are stripped and string literals kept, so prose like
  // "sha256 by default" is untouched while a real literal is caught. digest.js
  // is the owner and is excluded.
  const algos = Object.keys(DIGESTS)
    .map((a) => a.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"))
    .join("|");
  const re = new RegExp(
    "createHash\\s*\\(\\s*[\"'](?:" + algos + ")[\"']|[\"'](?:" + algos + "):"
  );
  const files = _srcFiles().filter((f) => _relPath(f) !== "src/digest.js");
  let bad = _scanLines(files, re, { prepare: _stripComments });
  bad = _filterMarkers(bad, "digest-algo-hardcode");
  _report("SPEC.md 5: no createHash(\"<algo>\") or \"<algo>:\" literal outside src/digest.js (the registry owns the algorithm set)", bad);
});

// ---------------------------------------------------------------------------
// (1b) prototype-key-confusion -- untrusted-key registry membership (CWE-1321)
// ---------------------------------------------------------------------------

test("prototype-key-confusion -- no computed-member membership test against undefined", () => {
  // reason: a store indexes registries by UNTRUSTED strings -- a stored
  // digest's algorithm prefix (DIGESTS), a CLI subcommand token (COMMANDS).
  // Testing membership with `registry[key] === undefined` (or `!== undefined`)
  // reads through the prototype chain: a key naming an inherited
  // Object.prototype member ("constructor", "__proto__", "toString", "valueOf")
  // resolves to that member, is NOT undefined, and passes the membership test as
  // a PHANTOM row the registry never defined (CWE-1321, prototype-key
  // confusion). The phantom then defeats a `registry[key] ?? DEFAULT` fallback
  // or slips past an unknown-command guard. Membership over a computed
  // identifier key must go through `Object.hasOwn(registry, key)`, which never
  // consults the prototype. The shape is a computed member (`ident[ident]`, not
  // an array index `x[0]` or a string-literal key `x["k"]`) compared to
  // undefined; comments are stripped so the prose above is untouched. The
  // assign-then-compare variant (`const v = reg[key]; if (v === undefined)`) is
  // pinned by the digest and CLI behavioral vectors, which drive an inherited
  // key through the shipped read and command-dispatch paths.
  const re = /[A-Za-z_$][\w$]*\[[A-Za-z_$][\w$]*\]\s*(?:===|!==)\s*undefined/;
  let bad = _scanLines(_srcFiles(), re, { prepare: _stripComments });
  bad = _filterMarkers(bad, "prototype-key-confusion");
  _report("CWE-1321: no `registry[key] === undefined` membership test in src/ -- use Object.hasOwn (the prototype chain is not a registry row)", bad);
});

// ---------------------------------------------------------------------------
// (2) sandbox-widening-import -- SPEC.md 2.1
// ---------------------------------------------------------------------------

test("sandbox-widening-import -- src/ never widens the permission-model sandbox", () => {
  // reason: the store must run under `node --permission` scoped to its own
  // root. Child processes, worker threads, cluster, WASI, process.binding,
  // and process.dlopen each need their own --allow-* grant and each widens
  // the sandbox; the store needs none of them. Comments are stripped;
  // string literals are kept because an import specifier IS a string.
  const re = /\b(?:node:)?child_process\b|\b(?:node:)?worker_threads\b|\bnode:cluster\b|\bnode:wasi\b|\bprocess\.binding\b|\bprocess\.dlopen\b/;
  let bad = _scanLines(_srcFiles(), re, { prepare: _stripComments });
  bad = _filterMarkers(bad, "sandbox-widening-import");
  _report("SPEC.md 2.1: no child_process / worker_threads / cluster / wasi / process.binding / process.dlopen in src/", bad);
});

// ---------------------------------------------------------------------------
// (3) permission-probe-branch -- SPEC.md 2.1
// ---------------------------------------------------------------------------

test("permission-probe-branch -- src/ never probes process.permission", () => {
  // reason: a library that checks process.permission.has() to branch
  // behaviour silently degrades when sandboxed -- worse than failing
  // loudly. If the grant is wrong, the ERR_ACCESS_DENIED must surface at
  // the operation that needed it.
  const re = /\bprocess\.permission\b/;
  let bad = _scanLines(_srcFiles(), re, { prepare: _stripComments });
  bad = _filterMarkers(bad, "permission-probe-branch");
  _report("SPEC.md 2.1: no process.permission capability probe in src/", bad);
});

// ---------------------------------------------------------------------------
// (4) error-event-emit -- SPEC.md 4.3
// ---------------------------------------------------------------------------

test("error-event-emit -- background failures never emit 'error'", () => {
  // reason: an unhandled 'error' event crashes a Node process, and a
  // background janitor must not be able to take the app down. The one
  // background failure channel is 'sweepError'; emitting 'error' from
  // anywhere in src/ reintroduces the crash vector.
  const re = /\bemit\s*\(\s*["'`]error["'`]/;
  let bad = _scanLines(_srcFiles(), re, { prepare: _stripComments });
  bad = _filterMarkers(bad, "error-event-emit");
  _report("SPEC.md 4.3: no emit('error') in src/ -- the background failure channel is 'sweepError'", bad);
});

// (4a) emit-outside-policy -- SPEC.md 4.3, 4.4
// ---------------------------------------------------------------------------

test("emit-outside-policy -- only the policy layer emits lifecycle events", () => {
  // reason: events are POLICY. A backend -- or any src module but stash.js --
  // calling .emit( would open a second event surface the emit-at-verb-layer
  // design and M7's silent store() (SPEC.md 4.4 echo suppression) cannot see, so
  // an entry replicated in could fire a spurious 'pushed'. Rename-proof: the call
  // SHAPE, not a symbol. stash.js is the one policy owner and is excluded.
  const re = /(?<![\w$.])emit\s*\(|\.emit\s*\(/;
  const files = _srcFiles().filter((f) => !/[\\/]stash\.js$/.test(f));
  let bad = _scanLines(files, re, { prepare: _stripComments });
  bad = _filterMarkers(bad, "emit-outside-policy");
  _report("SPEC.md 4.3: events are policy -- only src/stash.js emits (a backend emit is a second surface)", bad);
});

// ---------------------------------------------------------------------------
// (5) capability-in-error-message -- SPEC.md 10
// ---------------------------------------------------------------------------

test("capability-in-error-message -- typed stash errors carry static messages", () => {
  // reason: no error message ever contains a ref, a meta value, or a path.
  // A ref is a capability; an error that echoes one into a log file has
  // leaked it. Constructing any of the frozen SPEC.md 10 error classes
  // with a dynamic message (a template literal interpolation or a string
  // concatenation) is the shape by which an identifier reaches a message,
  // so the messages are static by construction. The class-name list is the
  // frozen public error contract -- a stable anchor, not a renameable
  // symbol.
  const classAlt = "(?:StashError|RefNotFound|RefClaimed|IntegrityError|SizeExceeded|StashFull|InvalidRef)";
  const callRe = new RegExp("new\\s+" + classAlt + "\\s*\\(([^)]{0,400})", "g");
  const files = _srcFiles();
  let bad = [];
  for (const file of files) {
    const rel = _relPath(file);
    const subject = _stripComments(_read(file));
    let m;
    while ((m = callRe.exec(subject)) !== null) {
      const args = m[1];
      if (/\$\{/.test(args) || /\+/.test(args)) {
        bad.push({
          file: rel,
          line: _lineOfIndex(subject, m.index),
          content: "typed stash error constructed with a dynamic message: " + m[0].replace(/\s+/g, " ").slice(0, 120),
        });
      }
    }
  }
  bad = _filterMarkers(bad, "capability-in-error-message");
  _report("SPEC.md 10: typed stash errors are constructed with static messages (no ${...}, no concatenation)", bad);
});

// ---------------------------------------------------------------------------
// (6) catch-return-swallow -- fail-closed verdicts
// ---------------------------------------------------------------------------

test("catch-return-swallow -- no catch absorbs an error into a return", () => {
  // reason: a catch must re-throw (typed) or propagate the caught error --
  // never absorb it into a returned value, default, or nothing. A
  // `catch { return ... }` or an empty `catch {}` turns a real failure
  // into a silent verdict: the caller proceeds on a value that encodes
  // "something broke" as "fine". Malformed input and storage failure are
  // permanent verdicts and must surface as typed throws.
  // The parameter matcher admits a destructured binding
  // (`catch ({ code }) { return ... }`) -- the same swallow shape -- and
  // one level of balanced parens inside it, so a default initializer that
  // calls a function (`catch ({ code = getStatus() }) { return ... }`)
  // does not end the parameter group at its first inner `)` and slip the
  // catch body past the scan.
  const re = /catch\s*(?:\((?:[^()]|\([^()]*\))*\)\s*)?\{\s*(?:return\b|\})/;
  const files = _srcFiles();
  let bad = [];
  for (const file of files) {
    const rel = _relPath(file);
    const subject = _stripCommentsAndLiterals(_read(file));
    const m = re.exec(subject);
    if (m) {
      bad.push({
        file: rel,
        line: _lineOfIndex(subject, m.index),
        content: "catch block returns / is empty instead of (re)throwing: " + m[0].replace(/\s+/g, " ").slice(0, 120),
      });
    }
  }
  bad = _filterMarkers(bad, "catch-return-swallow");
  _report("no catch-return / empty-catch swallow in src/ (a catch re-throws or propagates, never absorbs)", bad);
});

// ---------------------------------------------------------------------------
// (7) fail-open-verify -- a catch that reports success
// ---------------------------------------------------------------------------

test("fail-open-verify -- no catch returns a positive verdict", () => {
  // reason: a verify / read / claim routine that swallows an error and
  // then reports SUCCESS is fail-open: an input that makes the code throw
  // is treated as valid. The dangerous shape is a catch block whose body
  // returns a positive verdict (`return true`, `{ valid: true }`) or
  // signals stream success (a bare `callback()` / `cb()` / `done()`).
  // The tempered token `(?:(?!\n {0,4}\})[\s\S])` keeps the scan inside
  // the catch block -- a later, unrelated `return true` in a sibling
  // function is never attributed to the catch. Comments and literals are
  // stripped first.
  const VERDICT = "(?:true|1|valid|verified|isValid|ok)\\b" +
                  "|\\{[^}]*\\b(?:valid|verified|ok|allowed|trusted)\\s*:\\s*true";
  const failOpenRe = new RegExp(
    "catch\\s*(?:\\([^)]*\\)\\s*)?\\{" +
    "(?:(?!\\n {0,4}\\})[\\s\\S]){0,600}?" +
    "(?:\\breturn\\s+(?:" + VERDICT + ")|\\b(?:callback|cb|done)\\s*\\(\\s*\\))",
    "m"
  );
  const files = _srcFiles();
  let bad = [];
  for (const file of files) {
    const rel = _relPath(file);
    const subject = _stripCommentsAndLiterals(_read(file));
    const m = failOpenRe.exec(subject);
    if (m) {
      bad.push({
        file: rel,
        line: _lineOfIndex(subject, m.index),
        content: "fail-open: a catch block returns a positive verdict or signals success",
      });
    }
  }
  bad = _filterMarkers(bad, "fail-open-verify");
  _report("no fail-open verify shape in src/ (a catch that reports success)", bad);
});

// ---------------------------------------------------------------------------
// (7a) constant-time-compare-short-circuited -- timing side-channel via &&/||
// ---------------------------------------------------------------------------

test("constant-time-compare-short-circuited -- no CT compare is short-circuited by &&/||", () => {
  // reason: refs (capabilities) and digests both route their equality
  // through the single timing-safe compare (ref.constantTimeEqual, which
  // wraps node:crypto timingSafeEqual). Two such compares joined by && / ||
  // short-circuit the second: when the first is false the second never
  // runs, reopening the exact timing side-channel the compare exists to
  // close. Evaluate each into a variable, THEN combine.
  //
  // Two passes, file-scoped. PASS 1 derives the constant-time token set --
  // the frozen timingSafeEqual, the guard's exported constantTimeEqual, and
  // the name of any local function whose body wraps either (so a renamed
  // `_ctEq`-style delegate is recovered WITHOUT hardcoding its name). PASS 2
  // fires on two CT-token CALLS joined by &&/|| within one expression,
  // bounded away from ; { } so a wrapper DEFINITION and two separate
  // statements combining already-evaluated vars do not match.
  const bad = [];
  for (const file of _srcFiles()) {
    const rel = _relPath(file);
    const raw = _read(file);
    const stripped = _stripCommentsAndLiterals(raw);
    if (!/\btimingSafeEqual\b/.test(stripped) && !/\bconstantTimeEqual\b/.test(stripped)) continue;

    const toks = { timingSafeEqual: true, constantTimeEqual: true };
    const wrapRe = /(?:function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)|(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*=>?)\s*\{[^{}]*(?:timingSafeEqual|constantTimeEqual)/g;
    let wm;
    while ((wm = wrapRe.exec(stripped))) { toks[wm[1] || wm[2]] = true; }
    const alt = Object.keys(toks)
      .sort((a, b) => b.length - a.length)
      .map((t) => t.replace(/[$]/g, "\\$&"))
      .join("|");
    const pairRe = new RegExp(
      "\\b(?:" + alt + ")\\s*\\([^;{}]*?\\)\\s*(?:&&|\\|\\|)\\s*[^;{}]*?\\b(?:" + alt + ")\\s*\\("
    );

    const lines = _lines(stripped);
    for (let i = 0; i < lines.length; i++) {
      if (pairRe.test(lines[i])) {
        bad.push({
          file: rel,
          line: i + 1,
          content: "two constant-time compares joined by &&/|| short-circuit the second (timing side-channel) -- evaluate each into a var, then combine: " + lines[i].trim().slice(0, 80),
        });
      }
    }
  }
  const filtered = _filterMarkers(bad, "constant-time-compare-short-circuited");
  _report("no constant-time compare is short-circuited by &&/|| in src/", filtered);
});

// ---------------------------------------------------------------------------
// (8) non-ascii-source -- Trojan-Source defense
// ---------------------------------------------------------------------------

test("non-ascii-source -- src/, test/, scripts/ are pure ASCII", () => {
  // reason: a code point above 0x7F is either typographic drift in a
  // comment (house style is ASCII: '--', '->') or -- the dangerous class --
  // a Unicode lookalike inside an identifier or comparison (homoglyph /
  // bidi Trojan-Source shapes), which reads identically in review while
  // comparing unequal at runtime. Byte-level and rename-proof.
  const files = _srcFiles().concat(_testFiles(), _scriptFiles());
  let bad = [];
  for (const file of files) {
    const rel = _relPath(file);
    const lines = _lines(_read(file));
    for (let ln = 0; ln < lines.length; ln++) {
      for (const ch of lines[ln]) {
        const cp = ch.codePointAt(0);
        if (cp > 0x7f) {
          bad.push({
            file: rel,
            line: ln + 1,
            content: "non-ASCII code point U+" + cp.toString(16).toUpperCase() + ": " + lines[ln].trim().slice(0, 80),
          });
          break; // one report per line
        }
      }
    }
  }
  bad = _filterMarkers(bad, "non-ascii-source");
  _report("source tree is pure ASCII (Trojan-Source / homoglyph defense)", bad);
});

// ---------------------------------------------------------------------------
// (9) spdx-header -- machine-detectable license on every file
// ---------------------------------------------------------------------------

const SPDX_LINE_1 = "// SPDX-License-Identifier: Apache-2.0";
const SPDX_LINE_2 = "// Copyright (c) blamejs contributors";

test("spdx-header -- every source file opens with the SPDX pair", () => {
  // reason: the license must be machine-detectable in the published
  // tarball, per file, so a vendored or excerpted copy carries its terms
  // with it. The first two lines are the exact SPDX identifier and
  // copyright pair.
  const files = _srcFiles().concat(_testFiles(), _scriptFiles());
  let bad = [];
  for (const file of files) {
    const rel = _relPath(file);
    const lines = _lines(_read(file));
    // A file may open with a single `#!` shebang (an executable entry point, e.g.
    // a bin), which the SPDX pair then follows. The license stays mandatory -- the
    // shebang only shifts where it begins, it never waives it, so a shebang'd file
    // with no SPDX still fails.
    const offset = (lines[0] || "").startsWith("#!") ? 1 : 0;
    if ((lines[offset] || "").trim() !== SPDX_LINE_1 || (lines[offset + 1] || "").trim() !== SPDX_LINE_2) {
      bad.push({
        file: rel,
        line: 1,
        content: "missing/incorrect SPDX + copyright preamble (the first two lines, after an optional #! shebang)",
      });
    }
  }
  bad = _filterMarkers(bad, "spdx-header");
  _report("every src/, test/, scripts/ file opens with the SPDX + copyright pair", bad);
});

// ---------------------------------------------------------------------------
// (10) defer-marker -- no unfinished surface ships
// ---------------------------------------------------------------------------

test("defer-marker -- no TODO / FIXME / HACK / XXX / NOT_SUPPORTED / '// later'", () => {
  // reason: a deferral marker is an unfinished surface, not a shipped one.
  // Every capability either ships complete or is rejected loudly at config
  // time (the UNIMPLEMENTED_OPTIONS throw in src/stash.js is the fail-closed
  // OPPOSITE of a deferral marker and is deliberately not matched). The
  // caps sentinels are matched case-sensitively so prose is left alone.
  const reCaps = /\b(?:TODO|FIXME|XXX|HACK|NOT_SUPPORTED)\b/;
  const reLater = /\/\/\s*later\b/i;
  const files = _srcFiles().concat(_testFiles(), _scriptFiles());
  let bad = [];
  for (const file of files) {
    const rel = _relPath(file);
    if (rel === SELF) continue; // this file names the tokens in its own regexes
    const lines = _lines(_read(file));
    for (let i = 0; i < lines.length; i++) {
      if (reCaps.test(lines[i]) || reLater.test(lines[i])) {
        bad.push({ file: rel, line: i + 1, content: lines[i].trim() });
      }
    }
  }
  bad = _filterMarkers(bad, "defer-marker");
  _report("no deferral markers in src/, test/, scripts/", bad);
});

// ---------------------------------------------------------------------------
// (11) ai-attribution -- no tool attribution anywhere
// ---------------------------------------------------------------------------

test("ai-attribution -- no AI-attribution tokens in the tree", () => {
  // reason: operator-facing text describes the change, never the tool that
  // produced it -- not in comments, not in strings, not in examples. Token
  // list is concatenated so this gate file never matches itself.
  const tokens = [
    "cla" + "ude",
    "anthro" + "pic",
    "chat" + "gpt",
    "open" + "ai",
    "gpt" + "[-_ ]?[0-9]",
    "copi" + "lot",
    "co-auth" + "ored-by",
  ];
  const re = new RegExp("\\b(?:" + tokens.join("|") + ")\\b", "i");
  const files = _srcFiles().concat(_testFiles(), _scriptFiles(), _wikiFiles());
  let bad = _scanLines(files, re);
  bad = _filterMarkers(bad, "ai-attribution");
  _report("no AI-attribution tokens in src/, test/, scripts/, examples/", bad);
});

// ---------------------------------------------------------------------------
// (12) raw-time-scale-literal -- src/constants.js owns the scale facts
// ---------------------------------------------------------------------------

test("raw-time-scale-literal -- scale arithmetic routes through constants", () => {
  // reason: scale magnitudes live in ONE module (src/constants.js declares
  // C.TIME / C.BYTES; duration.js resolves '24h' -> ms through them); a
  // bare `* 1000` / `* 60` / `* 1024` elsewhere in src/ is a second source
  // of truth for scale math that drifts independently and that a reviewer
  // must decode by eye. constants.js is the single place the literals
  // legitimately live, so it is excluded.
  const re = /\*\s*(?:1000|1024|60)\b/;
  const files = _srcFiles().filter((f) => _relPath(f) !== "src/constants.js");
  let bad = _scanLines(files, re, { prepare: _stripCommentsAndLiterals });
  bad = _filterMarkers(bad, "raw-time-scale-literal");
  _report("no raw time/byte scale literals (* 1000 / * 60 / * 1024) outside src/constants.js", bad);
});

// ---------------------------------------------------------------------------
// (13) inline-dynamic-import -- static imports only
// ---------------------------------------------------------------------------

test("inline-dynamic-import -- no import() calls in src/", () => {
  // reason: every module's dependency set is declared at top of file where
  // a reader (and the sandbox reviewer) sees the whole surface at a
  // glance; a dynamic import() inside a function body loads code on a
  // path no static review walked. A documented circular-dependency is the
  // only exception, via the registered allow marker.
  const re = /\bimport\s*\(/;
  let bad = _scanLines(_srcFiles(), re, { prepare: _stripCommentsAndLiterals });
  bad = _filterMarkers(bad, "inline-dynamic-import");
  _report("no dynamic import() in src/ (top-of-file static imports only)", bad);
});

// ---------------------------------------------------------------------------
// (14) dead-underscore-function -- no orphaned internal helpers
// ---------------------------------------------------------------------------

test("dead-underscore-function -- every _helper is referenced", () => {
  // reason: linters commonly exempt `_`-prefixed identifiers from
  // no-unused-vars, so a `function _foo()` or `const _foo = ...` that is
  // never called hides as dead code no tool sees. An internal helper must
  // be intentional: referenced at least once in its own file beyond the
  // declaration, or removed.
  const declRe = /(?:^|\n)\s*(?:(?:async\s+)?function\s+(_[\w$]+)\s*\(|const\s+(_[\w$]+)\s*=)/g;
  const files = _srcFiles();
  let bad = [];
  for (const file of files) {
    const rel = _relPath(file);
    const src = _read(file);
    let m;
    while ((m = declRe.exec(src)) !== null) {
      const name = m[1] || m[2];
      const refs = (src.match(new RegExp("\\b" + name + "\\b", "g")) || []).length;
      if (refs <= 1) {
        bad.push({
          file: rel,
          line: _lineOfIndex(src, m.index + m[0].indexOf(name)),
          content: "unused `_`-prefixed declaration " + name + " -- dead code linters exempt; call it or remove it",
        });
      }
    }
  }
  bad = _filterMarkers(bad, "dead-underscore-function");
  _report("no unused `_`-prefixed functions/consts in src/", bad);
});

// ---------------------------------------------------------------------------
// (15) unimported-builtin-call -- every invoked builtin name is bound
// ---------------------------------------------------------------------------

// Parse the import statements out of comment-stripped source (specifiers
// are string literals, so strings must survive). Yields, per statement,
// the local bindings it creates and the module specifier it names.
const _IMPORT_RE =
  /import\s*(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s*as\s+([\w$]+))?\s*(?:from\s*)?["']([^"']+)["']/g;

function _importBindings(subject, each) {
  let m;
  _IMPORT_RE.lastIndex = 0;
  while ((m = _IMPORT_RE.exec(subject)) !== null) {
    const names = [];
    if (m[1]) names.push(m[1]);
    if (m[3]) names.push(m[3]);
    if (m[2]) {
      for (const part of m[2].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) names.push(name);
      }
    }
    each(names, m[4]);
  }
}

test("unimported-builtin-call -- no bare call to an unbound node builtin export", () => {
  // reason: a bare invocation of a node builtin export name (writeFileSync,
  // spawnSync, ...) that the file neither imports nor declares is a latent
  // ReferenceError on whichever branch reaches it -- and the unexercised
  // branch is often the rarely-run one (an error path, a release step), so
  // the crash ships silently. The name sets are read off the builtin
  // modules themselves at scan time via process.getBuiltinModule -- the
  // frozen upstream contract, not a renameable local -- and a name is
  // satisfied only by an import binding, a local declaration/parameter, or
  // being a global.
  const files = _allJsFiles();

  // Every node: module imported anywhere in the scanned tree contributes
  // its export names: a file that calls a builtin export without importing
  // its module at all is the same ReferenceError class.
  const builtinNames = new Set();
  for (const file of files) {
    _importBindings(_stripComments(_read(file)), (names, spec) => {
      if (!spec.startsWith("node:")) return;
      for (const name of Object.keys(process.getBuiltinModule(spec))) builtinNames.add(name);
    });
  }

  let bad = [];
  for (const file of files) {
    const rel = _relPath(file);
    const raw = _read(file);
    const subject = _stripCommentsAndLiterals(raw);
    const bound = new Set();
    _importBindings(_stripComments(raw), (names) => {
      for (const name of names) bound.add(name);
    });
    // Declarations, destructurings, and function/arrow parameters.
    const declRe = /\b(?:function|class|const|let|var)\s+([\w$]+)/g;
    let m;
    while ((m = declRe.exec(subject)) !== null) bound.add(m[1]);
    const destructRe = /\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g;
    while ((m = destructRe.exec(subject)) !== null) {
      for (const tok of m[1].split(/[,:]/)) {
        const name = tok.trim().replace(/=.*$/, "").trim();
        if (/^[\w$]+$/.test(name)) bound.add(name);
      }
    }
    const paramRe = /\bfunction\s*[\w$]*\s*\(([^()]*)\)|(?<![\w$])\(([^()]*)\)\s*=>|(?<![\w$.])([\w$]+)\s*=>/g;
    while ((m = paramRe.exec(subject)) !== null) {
      for (const tok of (m[1] || m[2] || m[3] || "").split(",")) {
        const name = tok.trim().replace(/=.*$/, "").trim();
        if (/^[\w$]+$/.test(name)) bound.add(name);
      }
    }
    const lines = _lines(subject);
    const rawLines = _lines(raw);
    for (let i = 0; i < lines.length; i++) {
      // Exclude a leading `#` too: `this.#init()` is a private-method call, never
      // a bare builtin invocation (node:events exports an `init`, so the private
      // name would otherwise false-positive).
      const callRe = /(?<![.\w$#])([A-Za-z_$][\w$]*)\s*\(/g;
      let c;
      while ((c = callRe.exec(lines[i])) !== null) {
        const name = c[1];
        if (!builtinNames.has(name) || bound.has(name) || name in globalThis) continue;
        // Method-definition shorthand (`name(params) {`) declares, never calls.
        if (/^[\w$]+\s*\([^()]*\)\s*\{/.test(lines[i].slice(c.index))) continue;
        bad.push({
          file: rel,
          line: i + 1,
          content: "bare call to unbound builtin export '" + name + "': " + (rawLines[i] || "").trim(),
        });
      }
    }
  }
  bad = _filterMarkers(bad, "unimported-builtin-call");
  _report("every invoked node builtin export name is imported or locally bound", bad);
});

// (16) path-reresolved-read -- storage reads open an fd, never re-resolve a path
// ---------------------------------------------------------------------------

test("path-reresolved-read -- no path-based blob/sidecar read in src/", () => {
  // reason: a stored file is read through a descriptor it opened and
  // verified with fstat on that fd, never by handing a path to
  // createReadStream / readFile a second time. A path passed to a read
  // AFTER a separate stat / lstat check is re-resolved by the kernel when
  // the read opens it, so a symlink or a different file swapped in between
  // the check and the read is silently followed -- the time-of-check
  // time-of-use class (CWE-367), and a symlink escape past the containment
  // check. The FileHandle method forms (fh.createReadStream(), fh.readFile())
  // read the already-open, already-verified descriptor and are the required
  // shape; the free-function forms re-resolve the path. Anchored on the Node
  // API names (a stable contract, like the timingSafeEqual / realpath
  // guards), so it is rename-proof; the negative lookbehind keeps the method
  // forms and identifier suffixes out.
  const re = /(?<![.\w])(?:createReadStream|readFileSync|readFile)\s*\(/;
  let bad = _scanLines(_srcFiles(), re, { prepare: _stripCommentsAndLiterals });
  bad = _filterMarkers(bad, "path-reresolved-read");
  _report("no path-based createReadStream/readFile in src/ (open an fd and read the handle -- CWE-367)", bad);
});

// ---------------------------------------------------------------------------
// npm-shim-bare-spawn -- npm/npx invoked as a bare command, never through a shell
// ---------------------------------------------------------------------------

test("npm-shim-bare-spawn -- npm/npx runs through a shell, never a bare spawn", () => {
  // reason: `npm` and `npx` resolve to `.cmd` shims on Windows that Node
  // refuses to spawn directly, so passing "npm" as the command with an args
  // array -- whether to spawnSync/spawn/execFile or to a capture/run wrapper --
  // returns ENOENT on Windows while passing on Linux CI. That is an OS-specific
  // break the Linux runner cannot see: it is what falsely failed the 0.1.4
  // publish verification. The required form is the shell command STRING
  // (spawnSync("npm view ...", [], { shell: true })), where "npm" is followed
  // by its subcommand inside the string rather than being the whole first
  // argument. Anchored on the command-plus-args-array SHAPE ("npm" | "npx" as a
  // complete literal immediately followed by `, [`), not a spawn function name,
  // so a renamed wrapper is still caught and the shell command-string form
  // stays silent (its literal is "npm <sub>...", never bare "npm"). A bare
  // spawn whose args come from a variable rather than an inline array is the
  // documented residual; tooling here always passes the array inline.
  // The quote class is written with hex escapes (\x22 = ", \x27 = ') so this
  // regex literal carries no bare quote that the shared comment/literal
  // stripper (which does not parse regex literals) would mis-pair.
  const re = /[\x22\x27](?:npm|npx)[\x22\x27]\s*,\s*\[/;
  let bad = _scanLines(_scriptFiles().concat(_testFiles(), _srcFiles()), re, {
    prepare: _stripComments,
    skipSelf: true,
  });
  bad = _filterMarkers(bad, "npm-shim-bare-spawn");
  _report("no bare npm/npx spawn (use the shell command-string form -- npm is npm.cmd on Windows)", bad);
});

// ---------------------------------------------------------------------------
// unretried-fs-mutation -- every disk-backend rename/link is transient-retried
// ---------------------------------------------------------------------------

test("unretried-fs-mutation -- every disk-backend rename/link routes through the transient-fault retry", () => {
  // reason: a rename or link on the disk backend can fail with a TRANSIENT
  // EPERM/EACCES/EBUSY on Windows while a just-closed handle lingers (antivirus,
  // indexer, or the OS lazily releasing it) -- a legitimate operation racing
  // that window, not a real fault. Every mutating rename/link therefore routes
  // through _retryTransient, which re-attempts on exactly those codes and is
  // inert on POSIX (first-try success); a BARE call dies on the first transient
  // hit, and for a write the cleanup then destroys the just-streamed bytes.
  // Anchored on the Node fs API names (rename/link/unlink -- a frozen contract,
  // like the createReadStream / realpath guards) and the retry-wrapper routing
  // shape, so it is rename-proof: a bare mutation fires wherever it appears
  // (including a not-yet-written line), and the retried form stays silent. rm
  // is deliberately NOT scanned -- its many cleanup calls are force-removes
  // whose ENOENT is a witness, not a mutation that must survive contention. A
  // genuinely-immediate rename/link carries an allow:unretried-fs-mutation
  // marker with its reason.
  const diskPath = path.join(REPO_ROOT, "src", "backends", "disk.js");
  const src = _read(diskPath);
  const callRe = /(?<![\w$])(?:rename|link|unlink)\s*\(/;
  const routedRe = /_retryTransient\s*\(\s*\(\s*\)\s*=>\s*(?:rename|link|unlink)\s*\(/;
  const stripped = _lines(_stripComments(src));
  // Floor: the scan must see real mutation calls, or a moved/renamed backend
  // file would green this gate vacuously.
  assert.ok(
    stripped.some((l) => callRe.test(l)),
    "no rename/link/unlink calls found in src/backends/disk.js -- detector vacuous (file moved?)"
  );
  let bad = [];
  for (let i = 0; i < stripped.length; i++) {
    if (callRe.test(stripped[i]) && !routedRe.test(stripped[i])) {
      bad.push({
        file: _relPath(diskPath),
        line: i + 1,
        content: "bare fs rename/link/unlink -- route through _retryTransient (absorbs a transient Windows EPERM/EACCES/EBUSY): " + stripped[i].trim().slice(0, 100),
      });
    }
  }
  bad = _filterMarkers(bad, "unretried-fs-mutation");
  _report("every disk-backend rename/link routes through _retryTransient (transient-fault retry)", bad);
});

// ---------------------------------------------------------------------------
// Allow-marker audit -- every allow:<class> names a registered class
// ---------------------------------------------------------------------------

test("allow-marker audit -- every marker names a registered class", () => {
  // reason: a marker naming an unregistered class suppresses nothing (the
  // detector it claims to silence does not exist), so the violation it
  // meant to document ships unflagged. Every marker in the tree must name
  // a class in VALID_ALLOW_CLASSES.
  const re = /(?:allow:|codebase-patterns:allow-file\s+)([a-z0-9][a-z0-9-]*)/g;
  const files = _allJsFiles();
  let bad = [];
  for (const file of files) {
    const rel = _relPath(file);
    if (rel === SELF) continue; // this file lists the class ids themselves
    const lines = _lines(_read(file));
    for (let i = 0; i < lines.length; i++) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(lines[i])) !== null) {
        if (!VALID_ALLOW_CLASSES[m[1]]) {
          bad.push({ file: rel, line: i + 1, content: "unregistered allow-class '" + m[1] + "'" });
        }
      }
    }
  }
  _report("every allow:<class> / allow-file marker names a registered detector class", bad);
});

// ---------------------------------------------------------------------------
// Guard / validator enforcement family
//
// A fail-closed choke point (a guard: traversal whitelist, timing-safe
// compare, the canonical Entry shape) or an input-shape validator is
// defined ONCE, in one owning function, tagged in the comment block above
// its export:
//
//   // @enforced-by <detector-class> | behavioral -- <reason>
//   // @guard-shape <rename-proof regex of the shape>   (or @validator-shape)
//   // @guard-via   <regex of a legitimate routing call> (optional)
//
// The shapes are read OFF the tagged functions (single source of truth):
// these two tests are DERIVED, so a new guard is enforced the moment it is
// tagged, and an untagged guard cannot ship.
// ---------------------------------------------------------------------------

const _TAGGED_DECL_RE =
  /((?:^[ \t]*\/\/[^\n]*\n)+)[ \t]*export\s+(?:async\s+)?(?:function|class|const)\s+([\w$]+)/gm;

function _collectTaggedExports() {
  const found = [];
  for (const file of _srcFiles()) {
    const rel = _relPath(file);
    const src = _read(file);
    let m;
    _TAGGED_DECL_RE.lastIndex = 0;
    while ((m = _TAGGED_DECL_RE.exec(src)) !== null) {
      const block = m[1];
      const tags = {
        shapes: [],
        vias: [],
        kinds: [],
        enforcedBy: null,
        behavioralReason: false,
      };
      for (const line of _lines(block)) {
        let t;
        if ((t = /\/\/\s*@guard-shape\s+(.+?)\s*$/.exec(line)) !== null) {
          tags.shapes.push(t[1]);
          tags.kinds.push("guard");
        } else if ((t = /\/\/\s*@validator-shape\s+(.+?)\s*$/.exec(line)) !== null) {
          tags.shapes.push(t[1]);
          tags.kinds.push("validator");
        } else if ((t = /\/\/\s*@guard-via\s+(.+?)\s*$/.exec(line)) !== null) {
          tags.vias.push(t[1]);
        } else if ((t = /\/\/\s*@enforced-by\s+(\S+)(.*)$/.exec(line)) !== null) {
          tags.enforcedBy = t[1];
          tags.behavioralReason = t[1] === "behavioral" && /--/.test(t[2] + block);
        }
      }
      if (tags.shapes.length > 0 || tags.enforcedBy !== null) {
        found.push({
          file: rel,
          name: m[2],
          line: _lineOfIndex(src, m.index + m[0].length - 1),
          ...tags,
        });
      }
    }
  }
  return found;
}

test("guard/validator enforcement -- every tagged choke point declares its detector", () => {
  // reason: a choke point without an @enforced-by is an unenforced
  // promise -- nothing stops the next module from re-inlining the shape it
  // owns. Every function carrying a @guard-shape / @validator-shape must
  // name the detector class that enforces it (registered above) or declare
  // `behavioral -- <reason>` when the RED conformance vector IS the guard.
  const bad = [];
  for (const g of _collectTaggedExports()) {
    if (g.shapes.length > 0 && g.enforcedBy === null) {
      bad.push({ file: g.file, line: g.line, content: g.name + " has @guard-shape but no @enforced-by" });
    } else if (g.enforcedBy === "behavioral") {
      if (!g.behavioralReason) {
        bad.push({ file: g.file, line: g.line, content: g.name + " declares behavioral enforcement without a `-- <reason>`" });
      }
    } else if (g.enforcedBy !== null && !VALID_ALLOW_CLASSES[g.enforcedBy]) {
      bad.push({ file: g.file, line: g.line, content: g.name + " names unregistered detector class '" + g.enforcedBy + "'" });
    } else if (g.enforcedBy !== null && g.enforcedBy !== "behavioral" && /shape-reinlined$/.test(g.enforcedBy) && g.shapes.length === 0) {
      bad.push({ file: g.file, line: g.line, content: g.name + " claims shape enforcement but declares no shape" });
    }
  }
  _report("every @guard-shape / @validator-shape export declares a registered @enforced-by", bad);
});

test("guard/validator shape reinlined -- no module re-implements a tagged choke point", () => {
  // reason: the whole value of a choke point is that its shape exists in
  // exactly one place; a re-inline anywhere else (including a module that
  // does not exist yet) reintroduces the bug class it was built to end --
  // a second traversal regex to keep correct, a second comparison with a
  // timing leak, a second Entry construction that drifts from the canon.
  // The shapes are read off the guards themselves; comments are stripped
  // from scanned files so tags and prose never match, but string and
  // regex literals stay visible (a re-declared pattern IS the violation).
  const guards = _collectTaggedExports().filter((g) => g.shapes.length > 0);
  const bad = [];
  for (const g of guards) {
    const shapeRes = g.shapes.map((s) => new RegExp(s));
    const viaRes = g.vias.map((v) => new RegExp(v));
    for (const file of _srcFiles()) {
      const rel = _relPath(file);
      if (rel === g.file) continue;
      const lines = _lines(_stripComments(_read(file)));
      for (let i = 0; i < lines.length; i++) {
        for (const re of shapeRes) {
          if (!re.test(lines[i])) continue;
          if (viaRes.some((v) => v.test(lines[i]))) continue;
          bad.push({
            file: rel,
            line: i + 1,
            content: "re-inlines the " + g.name + " shape owned by " + g.file + " -- route through the guard",
          });
        }
      }
    }
  }
  const kinds = new Set(guards.flatMap((g) => g.kinds));
  let filtered = bad;
  if (kinds.has("guard")) filtered = _filterMarkers(filtered, "guard-shape-reinlined");
  if (kinds.has("validator")) filtered = _filterMarkers(filtered, "validator-shape-reinlined");
  _report("no src module re-inlines a shape owned by a tagged guard/validator", filtered);
});

test("wiki port agrees across the Dockerfile, composes, Caddyfile, and release-container smoke", () => {
  // class: wiki-port-cross-artifact-drift
  // reason: the wiki's HTTP port is declared in examples/wiki/Dockerfile
  // (ENV WIKI_PORT + EXPOSE + HEALTHCHECK) and repeated in the compose
  // files' port mappings, the Caddyfile's reverse-proxy fallback, and
  // release-container.yml's post-publish smoke (`-p X:X` + `curl
  // localhost:X/healthz`). A silent mismatch ships a container whose
  // proxy or smoke targets a port nothing listens on -- the release
  // passes CI but the published site is unreachable. Anchor on the
  // Dockerfile's ENV WIKI_PORT (the one authoritative declaration) and
  // assert every port token in the sibling artifacts matches it.
  const bad = [];
  let dockerfile;
  try { dockerfile = _read(path.join(REPO_ROOT, "examples", "wiki", "Dockerfile")); }
  catch (_e) { return; }
  const dfMatch = /WIKI_PORT\s*=\s*(\d+)/.exec(dockerfile);
  if (!dfMatch) return;
  const wikiPort = dfMatch[1];

  const workflowRel = ".github/workflows/release-container.yml";
  let workflow = null;
  try { workflow = _read(path.join(REPO_ROOT, workflowRel)); } catch (_e) { /* optional artifact */ }
  if (workflow !== null) {
    const lines = _lines(workflow);
    for (let i = 0; i < lines.length; i++) {
      const portMap = /-p\s+(\d+):(\d+)/.exec(lines[i]);
      if (portMap && (portMap[1] !== wikiPort || portMap[2] !== wikiPort)) {
        bad.push({ file: workflowRel, line: i + 1,
          content: "smoke `-p " + portMap[1] + ":" + portMap[2] +
                   "` doesn't match examples/wiki/Dockerfile WIKI_PORT=" + wikiPort });
      }
      const curlMatch = /localhost:(\d+)\/healthz/.exec(lines[i]);
      if (curlMatch && curlMatch[1] !== wikiPort) {
        bad.push({ file: workflowRel, line: i + 1,
          content: "smoke curls localhost:" + curlMatch[1] +
                   " but examples/wiki/Dockerfile WIKI_PORT=" + wikiPort });
      }
    }
  }

  // A compose port field is either a bare literal ("3011") or the
  // ${WIKI_PORT:-NNNN} interpolation form the operator overrides via .env
  // (server.js reads process.env.WIKI_PORT, so the override is live). The
  // effective default is the number after ":-". Extract it from EITHER shape
  // so parameterizing the fields does not silently disable this check -- a
  // regex that only matched a bare literal would go green on the
  // interpolated form and stop gating those artifacts entirely.
  const PORT_TOKEN = "(?:\\$\\{WIKI_PORT:-\\d+\\}|\\d+)";
  const mapRe    = new RegExp('-\\s+"(' + PORT_TOKEN + '):(' + PORT_TOKEN + ')"');
  const envRe    = new RegExp('WIKI_PORT:\\s*"(' + PORT_TOKEN + ')"');
  const exposeRe = new RegExp('-\\s+"(' + PORT_TOKEN + ')"\\s*$');
  // token -> effective port default: the number inside ${WIKI_PORT:-NNNN},
  // or the bare literal itself.
  const _portDefault = (token) => {
    const interp = /\$\{WIKI_PORT:-(\d+)\}/.exec(token);
    if (interp) return interp[1];
    const literal = /^\d+$/.exec(token);
    return literal ? literal[0] : null;
  };

  for (const composeName of ["docker-compose.yml", "docker-compose.prod.yml"]) {
    const rel = "examples/wiki/" + composeName;
    let compose = null;
    try { compose = _read(path.join(REPO_ROOT, "examples", "wiki", composeName)); } catch (_e) { continue; }
    const lines = _lines(compose);
    for (let i = 0; i < lines.length; i++) {
      const mapMatch = mapRe.exec(lines[i]);
      if (mapMatch && composeName === "docker-compose.yml" &&
          (_portDefault(mapMatch[1]) !== wikiPort || _portDefault(mapMatch[2]) !== wikiPort)) {
        bad.push({ file: rel, line: i + 1,
          content: "port mapping `" + mapMatch[1] + ":" + mapMatch[2] +
                   "` doesn't match examples/wiki/Dockerfile WIKI_PORT=" + wikiPort });
      }
      const envMatch = envRe.exec(lines[i]);
      if (envMatch && _portDefault(envMatch[1]) !== wikiPort) {
        bad.push({ file: rel, line: i + 1,
          content: "WIKI_PORT `" + envMatch[1] +
                   "` doesn't match examples/wiki/Dockerfile WIKI_PORT=" + wikiPort });
      }
      const exposeMatch = exposeRe.exec(lines[i]);
      if (exposeMatch && composeName === "docker-compose.prod.yml" && _portDefault(exposeMatch[1]) !== wikiPort) {
        bad.push({ file: rel, line: i + 1,
          content: "expose `" + exposeMatch[1] +
                   "` doesn't match examples/wiki/Dockerfile WIKI_PORT=" + wikiPort });
      }
    }
  }

  let caddy = null;
  const caddyRel = "examples/wiki/Caddyfile";
  try { caddy = _read(path.join(REPO_ROOT, "examples", "wiki", "Caddyfile")); } catch (_e) { /* optional artifact */ }
  if (caddy !== null) {
    const lines = _lines(caddy);
    for (let i = 0; i < lines.length; i++) {
      const fbMatch = /\{\$WIKI_PORT:(\d+)\}/.exec(lines[i]);
      if (fbMatch && fbMatch[1] !== wikiPort) {
        bad.push({ file: caddyRel, line: i + 1,
          content: "Caddy fallback `{$WIKI_PORT:" + fbMatch[1] +
                   "}` doesn't match examples/wiki/Dockerfile WIKI_PORT=" + wikiPort });
      }
    }
  }

  const filtered = _filterMarkers(bad, "wiki-port-cross-artifact-drift");
  _report("wiki port agrees across examples/wiki/Dockerfile + composes + Caddyfile + release-container.yml", filtered);
});

test("every workflow action is github-owned or in the allow-list mirror (else the workflow silently startup_fails)", () => {
  // class: workflow-action-not-allowlisted
  // reason: the repository's GitHub Actions policy is `selected` -- an action a
  // workflow `uses:` that is NOT permitted by the repo's
  // actions/permissions/selected-actions setting is rejected BEFORE the workflow
  // can start, producing a `startup_failure` with no job logs. A gate that never
  // runs is worse than a failing one: it looks absent, not broken, and can lapse
  // for months unnoticed (the fuzz + release-container workflows did exactly that).
  // ALLOW mirrors that repo setting: github-owned actions (actions/*, github/*) are
  // always permitted; every OTHER `uses:` must match a pattern here AND the repo
  // setting -- keep the two in sync. Adding an action to a workflow means adding it
  // here and to the repo Actions allow-list, or CI silently stops running it.
  const ALLOW = [
    /^ossf\/scorecard-action(\/|@)/,
    /^google\/clusterfuzzlite\/actions\//,
    /^docker\//,
    /^aquasecurity\/trivy-action(\/|@)/,
    /^sigstore\/cosign-installer(\/|@)/,
    /^hadolint\/hadolint-action(\/|@)/,
    /^ludeeus\/action-shellcheck(\/|@)/,
  ];
  const dir = path.join(REPO_ROOT, ".github", "workflows");
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")); }
  catch (_e) { return; } // no workflows dir: nothing to check
  const bad = [];
  for (const f of files) {
    const lines = _lines(_read(path.join(dir, f)));
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(?:-\s*)?uses:\s*(['"]?)([^\s'"@]+(?:@[^\s#'"]+)?)/.exec(lines[i]);
      if (m === null) continue;
      const ref = m[2];
      // Only a real GitHub Action reference is owner/repo[/path]@ref -- it always
      // contains a slash. A bare `uses:` value (a CodeQL query-suite like
      // `security-extended`) is not an action and the Actions policy never gates it.
      if (!ref.includes("/")) continue;
      if (/^\.\//.test(ref)) continue; // a local composite action in this repo
      if (/^(?:actions|github)\//.test(ref)) continue; // github-owned: always allowed
      if (ALLOW.some((re) => re.test(ref))) continue;
      bad.push({
        file: ".github/workflows/" + f,
        line: i + 1,
        content: "action not in the allow-list mirror (would startup_fail under the repo Actions policy): " + ref,
      });
    }
  }
  _report("every workflow action is github-owned or allow-listed (mirror the repo Actions allow-list setting)", bad);
});

test("every repo-root file the wiki reads at runtime is COPYed by the wiki Dockerfile", () => {
  // class: wiki-runtime-file-uncopied
  // reason: the container is built from examples/wiki/Dockerfile, which
  // COPYs only the trees it names (src/, examples/wiki/). The page
  // generator renders its front-door Overview page from the repo-ROOT
  // SPEC.md, resolved as path.resolve(libDir, "..", "SPEC.md") -- a file
  // ABOVE both copied trees. If the Dockerfile does not also COPY that
  // file, the read throws in-container, the generator's try/catch drops the
  // page (fail open), and a site with a blank front door ships green: the
  // read succeeds locally, where the repo root is present, so the e2e never
  // sees it. Derive every repo-root file the runtime source reads -- the
  // FILE in a path.resolve(libDir/LIB_DIR, "..", "FILE") escape, or a
  // literal "../../FILE" -- and assert each is named by a COPY line in the
  // Dockerfile (or its top directory is copied). The required-file set is
  // READ OFF the source, never a frozen inventory, so renaming SPEC.md
  // updates the requirement automatically; the escape shape (path.resolve /
  // fs read + the src-dir binding) and the COPY contract are the anchors.
  const dockerfile = _read(path.join(REPO_ROOT, "examples", "wiki", "Dockerfile"));

  // The build-context source paths a COPY brings in. A COPY line is
  // `COPY <flags...> <src...> <dest>`: every non-flag arg except the final
  // destination is a source. Record each normalized path and its basename,
  // so a file copied directly OR the directory that contains it both count.
  const copied = new Set();
  for (const line of _lines(dockerfile)) {
    const m = /^\s*COPY\s+(.+)$/i.exec(line);
    if (!m) continue;
    const args = m[1].split(/\s+/).filter((a) => a && !a.startsWith("--"));
    for (const a of args.slice(0, -1)) {
      const norm = a.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
      if (!norm) continue;
      copied.add(norm);
      copied.add(norm.split("/").pop());
    }
  }
  const _isCopied = (file) => {
    const norm = file.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    return copied.has(norm) || copied.has(norm.split("/")[0]);
  };

  // Runtime source only: examples/wiki/*.js + examples/wiki/lib/*.js. The
  // e2e under test/ never runs in the container, so its reads are out of
  // scope; public/ and vendor/ are already skipped by the asset-mode walk.
  const runtimeFiles = _wikiFiles().filter((f) =>
    /^examples\/wiki\/(?:[^/]+|lib\/[^/]+)\.js$/.test(_relPath(f)));
  assert.ok(runtimeFiles.length > 0, "no wiki runtime files scanned -- detector would be vacuous");

  // Two escape shapes, both resolving ABOVE examples/wiki to the repo root:
  //   A) path.resolve(libDir|LIB_DIR, "..", "FILE") -- libDir/LIB_DIR is the
  //      library's src/ (repo-root/src), so one ".." lands at the repo root.
  //   B) a literal "../../FILE" -- a hardcoded climb out of examples/wiki/lib.
  const escapeA = /path\.resolve\(\s*(?:libDir|LIB_DIR)\s*,\s*["']\.\.["']\s*,\s*["']([^"']+)["']\s*\)/g;
  const escapeB = /["']\.\.\/\.\.\/([^"'/]+)["']/g;
  const bad = [];
  for (const file of runtimeFiles) {
    const rel = _relPath(file);
    const subject = _stripComments(_read(file));
    for (const re of [escapeA, escapeB]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(subject)) !== null) {
        if (_isCopied(m[1])) continue;
        bad.push({
          file: rel,
          line: _lineOfIndex(subject, m.index),
          content: "reads repo-root '" + m[1] + "' at runtime but examples/wiki/Dockerfile never COPYs it -- the container renders a blank/absent page",
        });
      }
    }
  }
  const filtered = _filterMarkers(bad, "wiki-runtime-file-uncopied");
  _report("every repo-root file the wiki reads at runtime is COPYed by examples/wiki/Dockerfile", filtered);
});
