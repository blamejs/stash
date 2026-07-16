// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
// source-comment-block-validator - shared validation engine for the
// source-driven wiki pipeline (`@module` + `@primitive` blocks in
// src/*.js).
//
// Two consumers import it:
//
//   1. examples/wiki/test/e2e.js
//        - wiki e2e gate; boots the generated site and validates the
//          blocks that drive it.
//   2. scripts/validate-source-comment-blocks.js
//        - library-level static gate. Runs from a clean checkout with no
//          install step, so block drift is caught pre-push in <5s.
//
// The validate() entry takes a config object:
//
//   {
//     libDir:  absolute path to the library's src/   (required)
//     parser:  the source-doc-parser module          (required)
//   }
//
// Returns an array of finding objects: { kind, file, primitive?, msg }.
//
// Signature convention: a primitive is either a call form
// (`stash.push(source, opts) -> Promise<string>`) or a constructor form
// (`new Stash(opts) -> Stash`). The engine validates signature SHAPE and
// code ARITY: a call-form signature is arity-checked against the matching
// exported function or class method; a constructor-form signature is
// arity-checked against the class's explicit constructor and passes when
// the class declares none.
//
// Pure module - no side effects at import-time.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

var ROOT_RE = /^\s*stash\./;

export var KNOWN_STATUSES = { stable: 1, experimental: 1, deprecated: 1 };

// Compliance-posture catalog. The compliance surface is the standards /
// assurance regimes a deployment answers to. Kept small and explicit - an
// unknown value is a typo, not a silent pass. (No block uses @compliance
// yet; the tag stays optional.)
export var KNOWN_POSTURES = {
  "soc2": 1, "iso-27001": 1, "fips-140-3": 1, "common-criteria": 1,
  "pci-dss": 1, "hipaa": 1, "gdpr": 1,
};

var SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/;

// Compare two X.Y.Z versions numerically (ignores any pre-release suffix):
// -1 if a < b, 0 if equal, 1 if a > b.
function _cmpSemver(a, b) {
  var pa = String(a).split("-")[0].split(".").map(Number);
  var pb = String(b).split("-")[0].split(".").map(Number);
  for (var i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

// @spec - the normative reference(s) a primitive is DERIVED FROM. This
// library's contract document is the shipped SPEC.md, cited by section
// number (`SPEC.md 4`); external standards (RFC / FIPS / ISO / W3C and
// friends) stay recognized for primitives that trace to one. A citation
// is validated (not free text) so it can be linked in the wiki and so
// naming the clause forces opening the spec. A trailing section clause
// (`sec. N`) and/or `(label)` is allowed; `internal (design: ...)` is the
// only escape for genuine infrastructure with no named source.
var _SPEC_OPT = "(?:\\s+(?:sec\\. [\\w.]+|\\([^)]*\\)))*";
var SPEC_PATTERNS = [
  new RegExp("^SPEC\\.md \\d+(?:\\.\\d+)*$"),
  new RegExp("^FIPS \\d+(?:-\\d+)?" + _SPEC_OPT + "$"),
  new RegExp("^(?:NIST )?SP 800-\\d+[A-Za-z]?(?:\\s+Rev\\.?\\s*\\d+)?" + _SPEC_OPT + "$"),
  new RegExp("^RFC \\d+" + _SPEC_OPT + "$"),
  new RegExp("^X\\.\\d+(?:-\\d+)?" + _SPEC_OPT + "$"),
  new RegExp("^ISO/IEC \\d+(?:-\\d+)?" + _SPEC_OPT + "$"),
  new RegExp("^IEC \\d+(?:-\\d+)?" + _SPEC_OPT + "$"),
  new RegExp("^W3C \\S.*$"),
  new RegExp("^(?:SemVer|semver\\.org)\\b.*$"),
  new RegExp("^internal(?:\\s+\\([^)]*\\))?$"),
];
export function isValidSpecRef(ref) {
  var r = String(ref).trim();
  for (var i = 0; i < SPEC_PATTERNS.length; i++) if (SPEC_PATTERNS[i].test(r)) return true;
  return false;
}

// @defends - the attack CLASS / CVE / CWE a primitive guards.
export function isValidDefendsRef(ref) {
  var r = String(ref).trim();
  // A ref that announces itself as a CVE/CWE MUST match the strict id form,
  // so a malformed "CVE-14-1568" is rejected rather than waved through as a
  // "named class" by the permissive fallback below.
  if (/^CVE-/i.test(r)) return /^CVE-\d{4}-\d+$/.test(r);
  if (/^CWE-/i.test(r)) return /^CWE-\d+$/.test(r);
  // Otherwise a named class, optionally suffixed with the id it maps to.
  return /^[A-Za-z][A-Za-z0-9 /_.+-]*(?:\s+\((?:CVE-\d{4}-\d+|CWE-\d+)\))?$/.test(r);
}

// Placeholder patterns in @example bodies that signal unexecutable code.
export var EXAMPLE_PLACEHOLDERS = [
  { id: "ascii-arrow",    re: /\/\/\s*>\s+/m,                  hint: 'use "// -> ..." for expected-result comments - "// > " reads as a shell prompt' },
  { id: "todo",           re: new RegExp("\\/\\/\\s*TO" + "DO\\b", "i"),  hint: "remove placeholder markers from shipping examples" },
  { id: "pseudocode",     re: /\/\/\s*pseudocode\b/i,          hint: "examples must be runnable code; remove pseudocode marker" },
  { id: "fill-in",        re: /\.\.\.\s*(fill|replace|your)/i, hint: "concretize the placeholder with a real value" },
  { id: "angle-bracket",  re: /<[A-Z][A-Z0-9_-]*>/,            hint: "<PLACEHOLDER> looks like an angle-bracket placeholder - concretize the value" },
  { id: "square-replace", re: /\[\s*REPLACE[-_ ]?ME\s*\]/i,    hint: "replace the [REPLACE-ME] placeholder with a real value" },
];

// Bare identifier path of a signature / primitive tag: drop the argument
// list, whitespace, any `-> returnType` suffix, and a leading `new`. The
// root namespace IS `stash`, so the full dotted path is kept.
function _bare(sig) {
  return String(sig)
    .replace(/->[\s\S]*$/, "")     // drop return-type annotation
    .replace(/\([^)]*\)/g, "")     // drop argument lists
    .replace(/^\s*new\s+/, "")     // drop constructor keyword
    .replace(/\s+/g, "");
}
function _moduleNs(modTag) {
  return String(modTag || "").trim();
}
function _firstSegment(primTag) {
  return _bare(primTag).split(".")[0];
}

// Extract operator-facing export keys from an ESM source file. Supports
// declaration exports (`export class X`, `export function x`,
// `export const x`) and list exports (`export { a, b as c } from ...`).
// Underscore-prefixed names are conventionally private and skipped.
function _extractExportKeys(source) {
  var keys = {};
  var m;
  var declRe = /(?:^|\n)\s*export\s+(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(source)) !== null) keys[m[1]] = true;
  var listRe = /(?:^|\n)\s*export\s*\{([^}]*)\}/g;
  while ((m = listRe.exec(source)) !== null) {
    m[1].split(",").forEach(function (part) {
      var nm = part.trim();
      if (!nm) return;
      var as = nm.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      nm = as ? as[2] : nm.split(/\s+/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) keys[nm] = true;
    });
  }
  return Object.keys(keys).filter(function (k) { return !/^_/.test(k); });
}

// Probe the universe of signatures available for @related resolution.
// Sources: every @primitive under src/, plus every exported binding of
// each documented module (so a "see also" reference to a real export
// that has no @primitive block of its own still resolves, while a
// reference to a nonexistent member is caught as drift).
function _knownPrimitiveSet(docs, source_by_file) {
  var set = {};
  Object.keys(docs).forEach(function (file) {
    var rec = docs[file];
    rec.primitives.forEach(function (p) {
      var sig = p.tags && p.tags.primitive;
      if (sig) set[_bare(sig)] = true;
    });
    var modNs = rec.module ? _moduleNs(rec.module.tags && rec.module.tags.module) : null;
    if (!modNs) return;
    var src = source_by_file[file] || "";
    _extractExportKeys(src).forEach(function (k) {
      set[modNs + "." + k] = true;
    });
  });
  return set;
}

// Count parameters in a comma-separated parameter list, bracket-aware so
// a default value (`opts = {}`) or a destructuring pattern counts as one.
function _countParams(inner) {
  var s = String(inner).replace(/\?/g, "").trim();
  if (!s) return 0;
  var depth = 0;
  var n = 1;
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) n++;
  }
  return n;
}

// Count parameters in a signature's FIRST argument list, e.g.
// `stash.push(source, opts) -> Promise<string>` -> 2, `new Stash(opts)` -> 1.
// The `?` optional marker is dropped before counting.
function _signatureArity(signature) {
  var m = String(signature).match(/\(([^)]*)\)/);
  if (!m) return 0;
  return _countParams(m[1]);
}

// Find the declaration for `name` and return its declared arity, or -1
// when none is found (namespace objects and factory-built exports report
// -1 and skip the arity check). A constructor-form signature (`new X(...)`)
// resolves the class's explicit constructor; a class with no constructor
// reports -1 (nothing to drift against). Call forms resolve, in order:
// an exported function declaration, a function-valued binding, a class
// method (line-anchored so call sites don't match), any function
// declaration.
function _functionArity(source, name, signature) {
  if (/^\s*new\s/.test(String(signature || ""))) {
    var clsRe = new RegExp("(?:^|\\n)\\s*(?:export\\s+)?class\\s+" + name + "\\b");
    var cm = clsRe.exec(source);
    if (!cm) return -1;
    var ctor = /(?:^|\n)\s*constructor\s*\(([^)]*)\)/.exec(source.slice(cm.index));
    if (!ctor) return -1;
    return _countParams(ctor[1]);
  }
  var patterns = [
    new RegExp("(?:^|\\n)\\s*export\\s+(?:async\\s+)?function\\*?\\s+" + name + "\\s*\\(([^)]*)\\)"),
    new RegExp("(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+" + name + "\\s*=\\s*(?:async\\s+)?function\\*?\\s*\\(([^)]*)\\)"),
    new RegExp("(?:^|\\n)\\s*(?:async\\s+)?(?:static\\s+)?" + name + "\\s*\\(([^)]*)\\)\\s*\\{"),
    new RegExp("function\\s+" + name + "\\s*\\(([^)]*)\\)"),
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = patterns[i].exec(source);
    if (m) return _countParams(m[1]);
  }
  return -1;
}

// Parse-check an @example body. ESM import declarations are dropped
// first (their bindings are only referenced, never executed here), then
// the rest is wrapped as an async IIFE so top-level `const` / `await`
// is permitted. Returns null on success, error message on failure.
function _parseCheckExample(body) {
  var stripped = String(body).split("\n").map(function (l) {
    return /^\s*import\b/.test(l) ? "" : l;
  }).join("\n");
  var wrapped = "(async function () {\n" + stripped + "\n})();";
  try {
    new vm.Script(wrapped, { filename: "example.js" });
    return null;
  } catch (e) {
    return (e && e.message) || String(e);
  }
}

// validate(config) -> findings[]
export function validate(config) {
  if (!config || !config.libDir) throw new TypeError("validate(): config.libDir is required");
  if (!config.parser) throw new TypeError("validate(): config.parser is required");

  var libDir = config.libDir;
  var parser = config.parser;

  var findings = [];
  var docs = parser.parseTree(libDir);

  var source_by_file = {};
  Object.keys(docs).forEach(function (file) {
    try { source_by_file[file] = fs.readFileSync(file, "utf8"); } catch (_e) { source_by_file[file] = ""; }
  });

  var known = _knownPrimitiveSet(docs, source_by_file);

  Object.keys(docs).forEach(function (file) {
    var rec = docs[file];
    var rel = path.relative(libDir, file);
    var source = source_by_file[file] || "";
    var modNs = rec.module ? _moduleNs(rec.module.tags && rec.module.tags.module) : null;

    // ---- Pass: per-primitive checks ----
    rec.primitives.forEach(function (p) {
      var tags = p.tags || {};
      var primTag = tags.primitive;
      if (!primTag) {
        findings.push({ kind: "schema", file: rel, msg: "@primitive tag is empty" });
        return;
      }

      // 1. @primitive shape.
      if (!/^stash(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(primTag)) {
        findings.push({ kind: "schema", file: rel, primitive: primTag, msg: "@primitive must be `stash.X` / `stash.X.Y` form" });
      }

      // 2. @signature present + shaped like a call / constructor.
      if (!tags.signature) {
        findings.push({ kind: "schema", file: rel, primitive: primTag, msg: "missing @signature" });
      } else if (tags.signature.indexOf("(") === -1) {
        findings.push({ kind: "schema", file: rel, primitive: primTag, msg: "@signature must show a call or constructor form with an argument list, e.g. `" + primTag + "(...)` or `new X(...)`" });
      }

      // 3. prose body.
      if (!p.prose || p.prose.replace(/\s/g, "").length < 12) {
        findings.push({ kind: "schema", file: rel, primitive: primTag, msg: "prose body is empty or too short (<12 non-whitespace chars)" });
      }
      if (p.proseAfterMultiLine) {
        findings.push({
          kind: "ordering", file: rel, primitive: primTag,
          msg: "prose appears AFTER a multi-line tag (@opts/@example/@intro) - those greedily consume every following line. Move prose ABOVE the multi-line tags.",
        });
      }
      if (p.mixedKind) {
        findings.push({
          kind: "schema", file: rel, primitive: primTag,
          msg: "block declares multiple kinds (" + p.mixedKind.join(" + ") + ") - pick exactly one. Parser silently chose `" + p.kind + "`; the others are hidden.",
        });
      }

      // 4. @example present.
      var hasExample = (Array.isArray(tags.examples) && tags.examples.length > 0) || tags.exampleFile;
      if (!hasExample) {
        findings.push({ kind: "schema", file: rel, primitive: primTag, msg: "missing @example or @exampleFile" });
      }

      // 5. @status catalog.
      if (tags.status && !KNOWN_STATUSES[tags.status]) {
        findings.push({
          kind: "catalog", file: rel, primitive: primTag,
          msg: "@status must be one of " + Object.keys(KNOWN_STATUSES).join(" / ") + " (got `" + tags.status + "`)",
        });
      }

      // 6. @since semver.
      if (tags.since && (tags.since.length > 32 || !SEMVER_RE.test(tags.since))) {
        findings.push({
          kind: "catalog", file: rel, primitive: primTag,
          msg: "@since does not look like semver (got `" + tags.since + "`)",
        });
      }

      // 6a. @originated (the earlier version the callable was already reachable, when
      // the documented path was later corrected) - semver, and not later than @since.
      if (tags.originated) {
        if (tags.originated.length > 32 || !SEMVER_RE.test(tags.originated)) {
          findings.push({
            kind: "catalog", file: rel, primitive: primTag,
            msg: "@originated does not look like semver (got `" + tags.originated + "`)",
          });
        } else if (tags.since && SEMVER_RE.test(tags.since) && _cmpSemver(tags.originated, tags.since) > 0) {
          findings.push({
            kind: "catalog", file: rel, primitive: primTag,
            msg: "@originated `" + tags.originated + "` is later than @since `" + tags.since + "` (the origin cannot post-date the corrected path)",
          });
        }
      }

      // 7. @compliance catalog.
      if (tags.compliance) {
        String(tags.compliance).split(",").map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (p2) {
          if (!KNOWN_POSTURES[p2]) {
            findings.push({
              kind: "catalog", file: rel, primitive: primTag,
              msg: "@compliance value `" + p2 + "` not in posture catalog",
            });
          }
        });
      }

      // 7b. @spec - the normative reference(s) the primitive is derived from.
      //     Validated so a citation can't be free text; required on every
      //     primitive when config.requireSpec is set (a primitive with no
      //     named source is undocumented or unmoored from its contract).
      if (tags.spec) {
        String(tags.spec).split(",").map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (ref) {
          if (!isValidSpecRef(ref)) {
            findings.push({
              kind: "catalog", file: rel, primitive: primTag,
              msg: "@spec `" + ref + "` is not a recognized normative reference (SPEC.md N / FIPS / SP 800 / RFC / X.NNN / ISO/IEC / IEC / W3C / semver / internal)",
            });
          }
        });
      } else if (config.requireSpec) {
        findings.push({
          kind: "schema", file: rel, primitive: primTag,
          msg: "missing @spec - every primitive must name the contract section it builds off of (`SPEC.md N`, or `@spec internal (design: ...)` for genuine infrastructure)",
        });
      }

      // 7c. @defends - the attack class / CVE / CWE the primitive guards.
      if (tags.defends) {
        String(tags.defends).split(",").map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (ref) {
          if (!isValidDefendsRef(ref)) {
            findings.push({
              kind: "catalog", file: rel, primitive: primTag,
              msg: "@defends `" + ref + "` must be a CVE-YYYY-N, CWE-N, or a named class optionally suffixed with `(CVE-.../CWE-...)`",
            });
          }
        });
      }

      // 8. @related resolution. A reference resolves against every
      //    documented primitive and every export of a documented module;
      //    when the parent namespace is documented but the member is not
      //    exported anywhere, the reference is drift.
      if (tags.related) {
        String(tags.related).split(",").map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (refSig) {
          var bare = _bare(refSig);
          if (known[bare]) return;                     // member-level ref resolved
          var refNs = bare.indexOf(".") === -1 ? bare : bare.slice(0, bare.lastIndexOf("."));
          var nsHasAnyDocs = Object.keys(known).some(function (k) {
            return k === refNs || k.indexOf(refNs + ".") === 0;
          });
          if (nsHasAnyDocs && bare === refNs) return;  // bare-namespace ref to a documented namespace
          if (nsHasAnyDocs) {
            findings.push({
              kind: "cross-ref", file: rel, primitive: primTag,
              msg: "@related `" + refSig + "` - namespace `" + refNs + "` is documented but this member isn't there (drift?)",
            });
          }
          // else: forward reference to a not-yet-documented namespace - allowed.
        });
      }

      // 9. @primitive namespace must sit under the file's @module (case-sensitive -
      // a primitive is used at its exact, case-correct export path).
      if (modNs) {
        var primBare = _bare(primTag);
        if (primBare !== modNs && primBare.indexOf(modNs + ".") !== 0) {
          findings.push({
            kind: "schema", file: rel, primitive: primTag,
            msg: "@primitive namespace `" + primBare + "` does not match the file's @module `" + modNs + "`",
          });
        }
      }

      // 10. Signature / code arity match (skips when no declaration
      //     matches the primitive's last segment - namespace objects and
      //     constructor-less classes report -1).
      if (tags.signature && source) {
        var fnName = _bare(primTag).split(".").pop();
        var declaredArity = _functionArity(source, fnName, tags.signature);
        var sigArity = _signatureArity(tags.signature);
        if (declaredArity !== -1 && declaredArity !== sigArity) {
          findings.push({
            kind: "code-mismatch", file: rel, primitive: primTag,
            msg: "@signature shows " + sigArity + " arg(s) but the `" + fnName + "` declaration takes " + declaredArity + " - keep the comment in sync with the code",
          });
        }
      }

      // 11. @example syntax + placeholder detectors.
      if (Array.isArray(tags.examples)) {
        tags.examples.forEach(function (ex, i) {
          var err = _parseCheckExample(ex);
          if (err) {
            findings.push({
              kind: "example-syntax", file: rel, primitive: primTag,
              msg: "@example #" + (i + 1) + " fails to parse as JavaScript: " + err,
            });
          }
          EXAMPLE_PLACEHOLDERS.forEach(function (det) {
            if (det.re.test(ex)) {
              findings.push({
                kind: "example-placeholder", file: rel, primitive: primTag,
                msg: "@example #" + (i + 1) + " contains `" + det.id + "` placeholder - " + det.hint,
              });
            }
          });
        });
      }

      // 12. @primitive first segment agrees with @signature namespace root
      //     when the signature uses the `stash.` call form. Constructor
      //     forms (`new Stash(...)`) are exempt.
      if (tags.signature && ROOT_RE.test(tags.signature)) {
        var sigRoot = _firstSegment(tags.signature);
        var primRoot = _firstSegment(primTag);
        if (sigRoot && primRoot && sigRoot !== primRoot) {
          findings.push({
            kind: "schema", file: rel, primitive: primTag,
            msg: "@signature namespace `" + sigRoot + "` does not match @primitive namespace `" + primRoot + "`",
          });
        }
      }
    });

    // ---- Pass: @module metadata completeness ----
    if (rec.module && rec.primitives.length > 0) {
      var modTags = rec.module.tags || {};
      if (!modTags.nav) {
        findings.push({
          kind: "metadata", file: rel, primitive: "@module " + modNs,
          msg: "@module block lacks @nav - namespace will land in the catch-all 'Other' sidebar group. Add `@nav <GroupName>`.",
        });
      }
      if (!modTags.card) {
        findings.push({
          kind: "metadata", file: rel, primitive: "@module " + modNs,
          msg: "@module block lacks @card - namespace won't render a card on the home page. Add a `@card` block with a 1-2 sentence description.",
        });
      }
      if (!modTags.title) {
        findings.push({
          kind: "metadata", file: rel, primitive: "@module " + modNs,
          msg: "@module block lacks @title - sidebar label defaults to `" + modNs + "`. Add `@title <Display Name>`.",
        });
      }
    }
  });

  return findings;
}
