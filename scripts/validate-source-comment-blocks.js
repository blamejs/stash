// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
// scripts/validate-source-comment-blocks - library-level static gate that
// runs the source-driven wiki's @module + @primitive comment-block
// validator from a clean checkout.
//
// Why: the wiki pages are generated from the JSDoc-style @module /
// @primitive blocks above each src/ primitive. A drifted block (a missing
// @signature, a stale arity, an @example that no longer parses, an
// @related pointing at a member that was renamed) would only surface deep
// in the wiki e2e gate. Running the same engine here, alongside the other
// static gates, catches the drift pre-push in under five seconds.
//
// Pure script - no side effects, no network. Imports:
//   - examples/wiki/lib/source-comment-block-validator (the engine)
//   - examples/wiki/lib/source-doc-parser              (the parser)
//
// Exit codes:
//   0 - no findings
//   1 - findings present (each finding printed with its file + primitive)

import path from "node:path";

var ROOT    = path.resolve(import.meta.dirname, "..");
var LIB_DIR = path.join(ROOT, "src");

var engine = await import("../examples/wiki/lib/source-comment-block-validator.js");
var parser = await import("../examples/wiki/lib/source-doc-parser.js");

function _report(findings) {
  if (findings.length === 0) {
    console.log("[validate-source-comment-blocks] OK - no findings");
    return 0;
  }
  console.log("[validate-source-comment-blocks] " + findings.length + " finding(s):");
  findings.forEach(function (f, i) {
    console.log("  " + (i + 1) + ". [" + f.kind + "] " + f.file + (f.primitive ? " :: " + f.primitive : ""));
    console.log("     " + f.msg);
  });
  return 1;
}

var findings = engine.validate({
  libDir: LIB_DIR,
  parser: parser,
  // Every primitive must name the contract section it builds off of
  // (`SPEC.md N`, or a recognized external standard, or `@spec internal
  // (design: ...)` for genuine infrastructure with no named source).
  requireSpec: true,
});

process.exit(_report(findings));
