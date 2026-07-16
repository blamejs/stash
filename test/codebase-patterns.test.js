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
  "sandbox-widening-import": 1,
  "permission-probe-branch": 1,
  "error-event-emit": 1,
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
    if ((lines[0] || "").trim() !== SPDX_LINE_1 || (lines[1] || "").trim() !== SPDX_LINE_2) {
      bad.push({
        file: rel,
        line: 1,
        content: "missing/incorrect SPDX + copyright preamble (first two lines)",
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
