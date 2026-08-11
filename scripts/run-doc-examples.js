// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Executes every `@example` in the src/ comment blocks and fails if one does not
// run.
//
// The comment-block validator (scripts/validate-source-comment-blocks.js) only
// PARSE-checks an @example -- it compiles the body and throws the result away.
// That catches a typo and nothing else: an example calling a method that was
// renamed, an option that was removed, or an argument shape the code stopped
// accepting parses perfectly and is still wrong. Those blocks generate the wiki
// and ship in the tarball, so a reader copies them; this gate is what keeps them
// true. It walks the SAME parse tree the validator walks and actually runs each
// body.
//
// An example is executed as a real ES module, verbatim, with two mechanical
// changes and no sandbox:
//
//   - Its `import` declarations are hoisted to the top of the generated module
//     (a declaration is illegal inside the function the body runs in) and every
//     specifier -- a declaration's or a dynamic `import()`'s -- is resolved
//     through this package's own exports map, so
//     `@blamejs/stash/backends/disk` is checked against what package.json
//     actually publishes. A subpath removed from `exports` fails here.
//   - The rest of the body runs inside an async function, so the ambient bindings
//     of scripts/doc-example-world.js are in scope and an example that declares
//     its own `const stash` still shadows cleanly.
//
// Each example gets its OWN process, with a disposable working directory as its
// cwd. That is not tidiness. An example is only proven when the process that ran
// it exits 0, and "the import resolved" is a weaker claim than that: the
// documented `runBackendConformance` example hands its work to `node:test`, which
// runs the assertions AFTER the import settles, so an in-process harness would
// report success for a conformance example that fails. A separate process also
// bounds a wedged example, and keeps an example that writes to a relative path
// (`new DiskBackend({ root: "./.stash" })`) away from the checkout.
//
// A body that throws is a failure, and there is no way to opt out of running:
// the example world defines what an example may assume, and anything outside it
// is a documentation bug. An earlier cut carried an escape hatch -- a leading
// `// requires:` line naming an environment the gate could not build, which was
// then skipped. It is deliberately absent. Nothing needed it, and a skipped
// example can only be trusted as far as something can check that it still shows
// the call it documents, which needs a JavaScript parser this package will not
// take a dependency on. An unenforceable exemption is a skip list with better
// manners. Re-open it when a documented call genuinely cannot be executed here,
// with the enforcement designed alongside it.
//
// Before judging a single example, the gate proves it can still tell a good one
// from a broken one: it runs the CANARIES below -- bodies carrying each defect it
// exists to catch -- and fails if any verdict is not the expected one. A gate
// that has quietly stopped discriminating passes everything, and would look
// exactly like a clean tree.
//
// It spawns, so it lives in scripts/ rather than test/, for the reason
// scripts/run-examples.js gives: `node --test` auto-discovers anything beneath
// test/, and the sandboxed suite runs under `--permission`, which denies the
// spawn. This is dev tooling and may spawn; src/ may not.
//
//   node scripts/run-doc-examples.js
//
// Exit 0: every example ran. Exit 1: one threw, named with its primitive.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as parser from "../examples/wiki/lib/source-doc-parser.js";
import { WORLD_KEYS } from "./doc-example-world.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "src");
const WORLD_URL = pathToFileURL(join(ROOT, "scripts", "doc-example-world.js")).href;

// Generous per-example ceiling. Nothing documented here is slow; the ceiling
// exists so an example that never finishes is killed and reported as one named
// failure instead of hanging the pipeline.
const PER_EXAMPLE_MS = 30000;

// The two import-declaration forms an @example may use. Anything else starting
// with `import` cannot be hoisted reliably and is refused by name rather than
// mangled into a confusing syntax error.
const IMPORT_FROM = /^\s*import\s+[\s\S]*?\s+from\s*(["'])([^"']+)\1\s*;?\s*$/;
const IMPORT_BARE = /^\s*import\s*(["'])([^"']+)\1\s*;?\s*$/;
// A DECLARATION only. `import(...)` and `import.meta` are expressions: they are
// legal where the body already sits and must not be dragged to the module top,
// so the lookahead keeps them out of the hoisting path entirely.
const IMPORT_ANY = /^\s*import\b(?!\s*[.(])/;
// A dynamic import's specifier needs the same resolution as a declaration's, or
// it would be the one import form that cannot find the package it names.
const DYNAMIC_IMPORT = /import\(\s*(["'])([^"']+)\1\s*\)/g;
// Binding names an import line introduces, so the world never shadows one.
const IMPORT_BINDINGS = /^\s*import\s+([\s\S]+?)\s+from\s/;

// The defects this gate exists to catch, each as a body whose verdict is known.
// Run on every invocation, before any real example is judged. `ran` canaries
// prove the harness has not started failing everything; `fail` canaries prove it
// has not started passing everything -- including the one that hands its work to
// node:test, where the failure lands after the import has already resolved.
export const CANARIES = [
  {
    label: "a well-formed example",
    expect: "ran",
    body: "const entry = await stash.show(ref);\nentry.size;",
  },
  {
    label: "an example that declares its own binding over the world's",
    expect: "ran",
    body: 'const stash = "shadowed";\nstash.length;',
  },
  {
    label: "a renamed method",
    expect: "fail",
    body: "await stash.applyEntry(ref);",
  },
  {
    label: "an option the code no longer accepts",
    expect: "fail",
    body: 'await stash.push("x", { nosuchoption: 1 });',
  },
  {
    label: "an identifier the documented world does not define",
    expect: "fail",
    body: "await stash.drop(someRefFromNowhere);",
  },
  {
    label: "an import of a subpath the package does not publish",
    expect: "fail",
    body: 'import { Nope } from "@blamejs/stash/backends/nosuchbackend";',
  },
  {
    label: "an example whose assertion is deferred to node:test",
    expect: "fail",
    body:
      'import { test } from "node:test";\n' +
      'test("deferred", () => { throw new Error("the documented integration is broken"); });',
  },
  {
    label: "an example whose body executes nothing",
    expect: "fail",
    body: "// Drop the entry the ref names.\n// The ref is spent afterwards.",
  },
  {
    label: "an example that only imports, without showing a call",
    expect: "fail",
    body: 'import { Stash } from "@blamejs/stash";',
  },
];

// collectExamples(dir) -> [{ sig, index, body }]
// Every @example in the tree, module blocks included, in parse order.
//
// A block may also satisfy the comment-block validator with `@exampleFile`
// instead of `@example`. This gate cannot run one, so rather than pass over it in
// silence -- which would turn that tag into a way to document a primitive with
// nothing that has to keep working -- it is collected as an entry that fails and
// says why.
export function collectExamples(dir = SRC_DIR) {
  const docs = parser.parseTree(dir);
  const found = [];
  const take = (sig, tags) => {
    if (!tags) return;
    (tags.examples || []).forEach((body, i) => found.push({ sig, index: i + 1, body }));
    if (tags.exampleFile) {
      found.push({
        sig,
        index: (tags.examples || []).length + 1,
        body: "",
        unrunnable:
          "documents itself with @exampleFile (" +
          tags.exampleFile +
          "), which this gate cannot execute -- give it an @example body instead",
      });
    }
  };
  for (const file of Object.keys(docs)) {
    const doc = docs[file];
    if (doc.module) take((doc.module.tags && doc.module.tags.module) || file, doc.module.tags);
    for (const primitive of doc.primitives || []) {
      take((primitive.tags && primitive.tags.primitive) || file, primitive.tags);
    }
  }
  return found;
}

// Names bound by the example's own imports -- the world must not redeclare one.
function _importedBindings(lines) {
  const names = new Set();
  for (const line of lines) {
    const match = IMPORT_BINDINGS.exec(line);
    if (!match) continue;
    for (const token of match[1].replace(/[{}]/g, " ").split(",")) {
      const name = token
        .trim()
        .split(/\s+as\s+/)
        .pop()
        .trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

// What is left of a body once comments and whitespace are gone. Used only to ask
// whether anything would run, so stripping too eagerly (a `//` inside a string)
// can only leave MORE behind, never invent an empty body out of real code.
function _executableSource(lines) {
  return lines
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, "")
    .trim();
}

// Resolve one @example specifier the way an operator's own project would: node:
// builtins pass through, a package name goes through this package's exports map,
// and a relative path is refused -- a copied example cannot carry the repo's
// directory layout with it.
function _resolveSpecifier(spec) {
  if (isBuiltin(spec)) return spec;
  if (spec.startsWith(".") || spec.startsWith("/")) {
    throw new Error(
      "imports " +
        JSON.stringify(spec) +
        " -- an @example must import by published package name, not a path",
    );
  }
  try {
    return import.meta.resolve(spec);
  } catch {
    throw new Error("imports " + JSON.stringify(spec) + ", which this package does not publish");
  }
}

// buildExampleModule(body, worldUrl) -> ES module source that runs `body`.
// Throws with an operator-readable reason when the body cannot be hoisted.
export function buildExampleModule(body, worldUrl = WORLD_URL) {
  const imports = [];
  const rest = [];
  for (const line of String(body).split("\n")) {
    if (!IMPORT_ANY.test(line)) {
      rest.push(
        line.replace(DYNAMIC_IMPORT, (_m, _q, spec) => {
          return "import(" + JSON.stringify(_resolveSpecifier(spec)) + ")";
        }),
      );
      continue;
    }
    const match = IMPORT_FROM.exec(line) || IMPORT_BARE.exec(line);
    if (!match) {
      throw new Error("has an import this gate cannot hoist: " + line.trim());
    }
    const spec = match[2];
    imports.push(line.replace(/(["'])[^"']+\1/, JSON.stringify(_resolveSpecifier(spec))));
  }
  // A body of pure prose runs clean and proves nothing, which would make
  // "delete the code, keep the comment" the cheapest way past a red gate -- the
  // silent skip this file exists to refuse. Imports do not satisfy it either: an
  // example that only names where a symbol comes from never shows it being used.
  if (_executableSource(rest) === "") {
    throw new Error("has no executable statement -- an @example must show the call it documents");
  }
  const shadowed = _importedBindings(imports);
  const injected = WORLD_KEYS.filter((key) => !shadowed.has(key));
  return [
    ...imports,
    "import { makeWorld } from " + JSON.stringify(worldUrl) + ";",
    "const __world = await makeWorld();",
    "const { " + injected.join(", ") + " } = __world.bindings;",
    "try {",
    // The body runs inside a function rather than at module top level so an
    // example that constructs its own store can declare `const stash`, or a
    // `var`, without colliding with the ambient binding of the same name. It
    // stays async, so an example's top-level `await` still reads as written.
    "await (async () => {",
    ...rest,
    "})();",
    "} finally { await __world.close(); }",
  ].join("\n");
}

// Generated module names carry the primitive so a stack trace names it, plus a
// counter, so two bodies can never be written to one path.
let _seq = 0;

function _moduleName(sig) {
  _seq += 1;
  return String(sig).replace(/[^\w.-]+/g, "-") + "-" + _seq + ".mjs";
}

function _tail(text, lines) {
  return String(text || "")
    .trim()
    .split("\n")
    .slice(-lines)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ");
}

// runExample({ sig, index, body }, dir) -> { outcome: "ran" | "fail" }
// Writes the generated module into `dir` (which must exist) and runs it as its own
// process, with `dir` as its cwd. Exported so the gate's own canaries drive this
// exact path rather than a copy of it -- a harness only its own checks can reach
// proves nothing about the gate.
export function runExample(item, dir) {
  if (item.unrunnable) return { outcome: "fail", error: item.unrunnable };

  // The static half: an example importing a subpath the package does not publish,
  // or showing no call at all, is wrong before anything is executed -- and the
  // comment-block validator catches neither, because it strips import lines
  // before parse-checking.
  let source;
  try {
    source = buildExampleModule(item.body);
  } catch (e) {
    return { outcome: "fail", error: (e && e.message) || String(e) };
  }

  const file = join(dir, _moduleName(item.sig));
  writeFileSync(file, source);

  const result = spawnSync(process.execPath, [file], {
    cwd: dir,
    encoding: "utf8",
    timeout: PER_EXAMPLE_MS,
  });
  if (result.status === 0) return { outcome: "ran" };

  // Everything the example printed, on the failing path only: what a broken one
  // logged on its way down is the first thing worth reading.
  const output = _tail((result.stdout || "") + "\n" + (result.stderr || ""), 6);
  if (result.error) {
    return { outcome: "fail", error: "did not complete: " + result.error.message, output };
  }
  if (result.signal) {
    return {
      outcome: "fail",
      error: "killed (" + result.signal + ") after " + PER_EXAMPLE_MS + "ms",
      output,
    };
  }
  return { outcome: "fail", error: "exited " + result.status, output };
}

// runCanaries(dir, canaries) -> [misbehaving canary description]
// Empty means the gate still discriminates. The set is a parameter so a vector
// can hand in one whose verdict is deliberately wrong and watch the whole gate
// refuse to report -- otherwise the line that wires the canaries in is the one
// thing here nothing checks, and deleting it would leave every run green.
export function runCanaries(dir, canaries = CANARIES) {
  const wrong = [];
  for (const canary of canaries) {
    const outcome = runExample({ sig: "canary", index: 1, body: canary.body }, dir).outcome;
    if (outcome !== canary.expect) {
      wrong.push(canary.label + ": expected to " + canary.expect + ", got " + outcome);
    }
  }
  return wrong;
}

// runExamples() -> { total, ran, failures, canaries, brokenCanaries }
// Runs from a disposable directory; leaves nothing behind. `canaries` is the
// number that actually ran, so the summary's claim about them is drawn from the
// run rather than from the length of a constant.
export function runExamples(canaries = CANARIES) {
  const dir = mkdtempSync(join(tmpdir(), "stashjs-doc-examples-"));
  try {
    const brokenCanaries = runCanaries(dir, canaries);
    // A gate that cannot tell a broken example from a good one has no verdict to
    // give on the real ones, so it does not pretend to.
    if (brokenCanaries.length > 0) {
      return { total: 0, ran: 0, failures: [], canaries: canaries.length, brokenCanaries };
    }
    const items = collectExamples();
    const failures = [];
    let ran = 0;
    for (const item of items) {
      const result = runExample(item, dir);
      if (result.outcome === "ran") ran += 1;
      else failures.push({ sig: item.sig, index: item.index, ...result });
    }
    return { total: items.length, ran, failures, canaries: canaries.length, brokenCanaries };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* a temp directory the OS will reclaim */
    }
  }
}

// report(result) -> exit code. An empty parse is a finding, never a pass: a wrong
// source directory or a tree whose blocks were all deleted would otherwise report
// success having verified nothing.
export function report(result) {
  for (const broken of result.brokenCanaries || []) {
    console.error("FAIL  this gate no longer detects " + broken);
  }
  if ((result.brokenCanaries || []).length > 0) return 1;

  if (result.total === 0) {
    console.error("[run-doc-examples] FAIL  parsed no @example blocks from src/");
    return 1;
  }
  for (const failure of result.failures) {
    console.error("FAIL  " + failure.sig + " @example #" + failure.index);
    console.error("      " + failure.error);
    if (failure.output) console.error("      printed: " + failure.output);
  }
  const summary =
    "doc-examples: " +
    result.ran +
    " of " +
    result.total +
    " @example blocks executed; " +
    result.canaries +
    " canaries discriminate";
  if (result.failures.length > 0) {
    console.error("\n" + summary + ", " + result.failures.length + " failed");
    return 1;
  }
  console.log(summary);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = report(runExamples());
}
