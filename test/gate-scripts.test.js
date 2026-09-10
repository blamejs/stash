// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Behavioral vectors for the static gate scripts. Each gate is a plain
// node script with an import-safe core; these tests drive the exported
// core on fixture inputs and pin the fail-closed verdicts:
//
//   check-api-snapshot: the snapshot must match the live surface EXACTLY
//     -- a stale snapshot (un-snapshotted member, dropped @primitive
//     block, version bump) fails the gate instead of logging and passing,
//     so a member added without a refresh is never left unprotected.
//
//   regen-changelog: every entry in release-notes/ must be a well-formed
//     v<X>.<Y>.<Z>.json -- a misnamed file previously vanished from the
//     CHANGELOG silently, --check staying green.
//
//   source-comment-block validate(): an empty parse (wrong libDir, or a
//     tree with every doc block deleted) is a finding, not a pass.
//
//   run-doc-examples: the @example execution gate proves on every run that
//     it can still fail, by running canaries -- bodies carrying each defect
//     it exists to catch -- before it judges a single example. The vector
//     that matters most here hands it a canary whose expected verdict is
//     deliberately wrong and asserts the whole gate refuses to report:
//     without it, the line wiring the canaries in is the one thing nothing
//     checks, and deleting it would leave every run green. That vector
//     spawns, so it skips under the sandboxed suite the way cli.test.js
//     does; the rest -- the module shape, the imports refused, the world
//     injected -- needs no child and always runs.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { diffSnapshot, isClean } from "../scripts/check-api-snapshot.js";
import { checkLockfile } from "../scripts/check-lockfile-sync.js";
import { WORLD_KEYS, makeWorld } from "../scripts/doc-example-world.js";
import { loadNotes, render } from "../scripts/regen-changelog.js";
import {
  CANARIES,
  buildExampleModule,
  collectExamples,
  report,
  runExample,
  runExamples,
} from "../scripts/run-doc-examples.js";
import * as engine from "../examples/wiki/lib/source-comment-block-validator.js";
import * as parser from "../examples/wiki/lib/source-doc-parser.js";
import { SANDBOXED } from "./_helpers.js";
import { freshScratchDir } from "./_scratch.js";

// ---------------------------------------------------------------------------
// check-api-snapshot -- exact-match drift verdicts
// ---------------------------------------------------------------------------

function snapshotFixture() {
  return {
    packageVersion: "1.0.0",
    surface: {
      index: {
        kind: "object",
        members: {
          Stash: { kind: "class", arity: 1, methods: { push: { kind: "function", arity: 2 } } },
          version: { kind: "string" },
        },
      },
    },
    sinceByPrimitive: { "stash.push": "1.0.0" },
  };
}

// ---------------------------------------------------------------------------
// check-lockfile-sync
// ---------------------------------------------------------------------------

function lockPair({ pkg = {}, lock = {} } = {}) {
  const base = { name: "@blamejs/stash", version: "2.2.0", engines: { node: ">=24.21.0" } };
  return [
    { ...base, ...pkg },
    {
      name: base.name,
      version: base.version,
      lockfileVersion: 3,
      packages: { "": { ...base, ...lock } },
      ...(lock.__top || {}),
    },
  ];
}

test("lockfile-sync: a matching pair is clean", () => {
  const [pkg, lock] = lockPair();
  assert.deepEqual(checkLockfile(pkg, lock), []);
});

test("lockfile-sync: a raised Node floor that the lockfile did not follow is caught", () => {
  // The release edit is package.json alone; npm rewrites the lockfile only on
  // the next install, so the two ship disagreeing unless this fires.
  const [pkg, lock] = lockPair({
    pkg: { engines: { node: ">=24.21.0" } },
    lock: { engines: { node: ">=24.19.0" } },
  });
  const problems = checkLockfile(pkg, lock);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /engines\.node/);
  assert.match(problems[0], />=24\.19\.0/);
  assert.match(problems[0], />=24\.21\.0/);
});

test("lockfile-sync: an engines block missing from the lockfile is caught, not skipped", () => {
  const [pkg, lock] = lockPair({ lock: { engines: undefined } });
  const problems = checkLockfile(pkg, lock);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /engines\.node/);
});

test("lockfile-sync: a version bump the lockfile did not follow is still caught", () => {
  const [pkg, lock] = lockPair({ pkg: { version: "2.2.0" }, lock: { version: "2.1.0" } });
  assert.ok(checkLockfile(pkg, lock).some((p) => /version/.test(p)));
});

test("lockfile-sync: a dependency appearing in the lockfile is still caught", () => {
  const [pkg, lock] = lockPair();
  lock.packages["node_modules/left-pad"] = { version: "1.3.0" };
  assert.ok(checkLockfile(pkg, lock).some((p) => /dependency entr/.test(p)));
});

test("api-snapshot: identical surface and version is clean", () => {
  const diff = diffSnapshot(snapshotFixture(), snapshotFixture(), "1.0.0");
  assert.deepEqual(diff, { breaking: [], stale: [] });
  assert.equal(isClean(diff), true);
});

test("api-snapshot: an un-snapshotted added member fails the gate as stale", () => {
  const current = snapshotFixture();
  current.surface.index.members.extra = { kind: "function", arity: 0 };
  const diff = diffSnapshot(snapshotFixture(), current, "1.0.0");
  assert.equal(diff.breaking.length, 0);
  assert.equal(diff.stale.length, 1);
  assert.match(diff.stale[0], /index\.extra.*not snapshotted/);
  assert.equal(isClean(diff), false);
});

test("api-snapshot: an array that grew beyond the snapshot fails the gate as stale", () => {
  const base = snapshotFixture();
  base.surface.index.members.codes = { kind: "array", length: 3 };
  const current = snapshotFixture();
  current.surface.index.members.codes = { kind: "array", length: 4 };
  const diff = diffSnapshot(base, current, "1.0.0");
  assert.equal(diff.breaking.length, 0);
  assert.equal(diff.stale.length, 1);
  assert.match(diff.stale[0], /codes: array grew 3 -> 4/);
  assert.equal(isClean(diff), false);
});

test("api-snapshot: an array that shrank below the snapshot fails the gate as breaking", () => {
  const base = snapshotFixture();
  base.surface.index.members.codes = { kind: "array", length: 3 };
  const current = snapshotFixture();
  current.surface.index.members.codes = { kind: "array", length: 2 };
  const diff = diffSnapshot(base, current, "1.0.0");
  assert.equal(diff.breaking.length, 1);
  assert.match(diff.breaking[0], /codes: array shrank 3 -> 2/);
  assert.equal(isClean(diff), false);
});

test("api-snapshot: an un-snapshotted added entry point fails the gate as stale", () => {
  const current = snapshotFixture();
  current.surface["backends/tape"] = { kind: "object", members: {} };
  const diff = diffSnapshot(snapshotFixture(), current, "1.0.0");
  assert.equal(isClean(diff), false);
  assert.match(diff.stale[0], /backends\/tape.*entry point added/);
});

test("api-snapshot: a dropped @primitive block fails the gate as stale", () => {
  const current = snapshotFixture();
  current.sinceByPrimitive = {};
  const diff = diffSnapshot(snapshotFixture(), current, "1.0.0");
  assert.equal(isClean(diff), false);
  assert.match(diff.stale[0], /stash\.push.*no longer found/);
});

test("api-snapshot: a new @primitive block missing from the snapshot fails the gate as stale", () => {
  const current = snapshotFixture();
  current.sinceByPrimitive["stash.pop"] = "1.0.1";
  const diff = diffSnapshot(snapshotFixture(), current, "1.0.0");
  assert.equal(isClean(diff), false);
  assert.match(diff.stale[0], /stash\.pop.*not in the snapshot/);
});

test("api-snapshot: a package version bump without a refresh fails the gate as stale", () => {
  const diff = diffSnapshot(snapshotFixture(), snapshotFixture(), "1.0.1");
  assert.equal(isClean(diff), false);
  assert.match(diff.stale[0], /generated at package version 1\.0\.0.*1\.0\.1/);
});

test("api-snapshot: removed member, kind change, arity change, and @since rewrite are breaking", () => {
  const removed = snapshotFixture();
  delete removed.surface.index.members.version;
  assert.match(
    diffSnapshot(snapshotFixture(), removed, "1.0.0").breaking[0],
    /index\.version: removed/,
  );

  const rekinded = snapshotFixture();
  rekinded.surface.index.members.version = { kind: "number" };
  assert.match(
    diffSnapshot(snapshotFixture(), rekinded, "1.0.0").breaking[0],
    /kind changed string -> number/,
  );

  const rearitied = snapshotFixture();
  rearitied.surface.index.members.Stash.methods.push.arity = 3;
  assert.match(
    diffSnapshot(snapshotFixture(), rearitied, "1.0.0").breaking[0],
    /arity changed 2 -> 3/,
  );

  const redated = snapshotFixture();
  redated.sinceByPrimitive["stash.push"] = "1.0.9";
  assert.match(diffSnapshot(snapshotFixture(), redated, "1.0.0").breaking[0], /@since changed/);
});

// ---------------------------------------------------------------------------
// regen-changelog -- release-notes/ directory hygiene
// ---------------------------------------------------------------------------

const VALID_NOTE = JSON.stringify({
  version: "0.1.0",
  date: "2026-01-01",
  summary: "First cut.",
  sections: { Added: ["The first primitive."] },
});

function notesFixture(t, extraFiles) {
  const dir = freshScratchDir("release-notes");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "v0.1.0.json"), VALID_NOTE);
  for (const [name, content] of Object.entries(extraFiles || {})) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

test("changelog: a well-formed notes directory loads and renders", (t) => {
  const notes = loadNotes(notesFixture(t));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].version, "0.1.0");
  assert.match(render(notes), /^# Changelog\n/);
  assert.match(render(notes), /## 0\.1\.0/);
});

test("changelog: a misnamed release-notes entry fails instead of vanishing", (t) => {
  // v0.2.json misses the X.Y.Z shape the loader recognizes; before the
  // name gate it was silently skipped, its notes never reaching the
  // CHANGELOG while --check stayed green.
  const dir = notesFixture(t, { "v0.2.json": VALID_NOTE });
  assert.throws(() => loadNotes(dir), /unrecognized entr.*v0\.2\.json/s);
});

test("changelog: a stray non-note file in release-notes/ fails the gate", (t) => {
  const dir = notesFixture(t, { "notes-draft.txt": "scratch" });
  assert.throws(() => loadNotes(dir), /unrecognized entr.*notes-draft\.txt/s);
});

test("changelog: a malformed note still fails loudly", (t) => {
  const dir = notesFixture(t, { "v0.1.1.json": "{ not json" });
  assert.throws(() => loadNotes(dir), /v0\.1\.1\.json/);
});

test("changelog: notes sort newest first", (t) => {
  const second = JSON.stringify({
    version: "0.1.1",
    date: "2026-02-01",
    summary: "Second cut.",
    sections: { Fixed: ["A bug."] },
  });
  const notes = loadNotes(notesFixture(t, { "v0.1.1.json": second }));
  assert.deepEqual(
    notes.map((n) => n.version),
    ["0.1.1", "0.1.0"],
  );
});

// ---------------------------------------------------------------------------
// source-comment-block validate() -- empty-parse floor
// ---------------------------------------------------------------------------

test("comment-blocks: an empty parse is a finding, not a pass", (t) => {
  const dir = freshScratchDir("empty-lib");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const findings = engine.validate({ libDir: dir, parser, requireSpec: true });
  assert.ok(
    findings.length >= 1,
    "zero findings on a tree with zero documented files is fail-open",
  );
  assert.match(findings[0].msg, /no documented source files/);
});

// ---------------------------------------------------------------------------
// run-doc-examples -- the @example execution gate can actually fail
// ---------------------------------------------------------------------------

function exampleDir(t) {
  const dir = freshScratchDir("doc-examples");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));
  return dir;
}

// report() writes an operator's gate verdict. Called for its exit code from a
// passing test, it puts lines like "FAIL parsed no @example blocks" into a green
// suite log, where they read as a real failure -- so these calls are silenced.
function quietly(fn) {
  const real = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = real.log;
    console.error = real.error;
  }
}

test("doc-examples: the world hands out exactly the documented bindings", async () => {
  const world = await makeWorld();
  try {
    assert.deepEqual(Object.keys(world.bindings).sort(), [...WORLD_KEYS].sort());
    // Not just shaped right -- the state has to be real, or every example that
    // touches it would pass on a world that does nothing.
    assert.equal(typeof world.bindings.ref, "string");
    assert.equal(await world.bindings.stash.has(world.bindings.ref), true);
    assert.equal((await world.bindings.primary.list()).length, 2);
    assert.equal((await world.bindings.primary.tombstones()).length, 1);
    const [live] = await world.bindings.primary.list();
    assert.ok(Buffer.isBuffer(world.bindings.bytesFor(live.id)));
  } finally {
    await world.close();
  }
});

test("doc-examples: the parse walks the real tree", () => {
  const found = collectExamples();
  assert.ok(found.length > 0, "an empty parse would make the gate pass vacuously");
  assert.ok(found.every((item) => item.sig && item.body));
  assert.ok(found.some((item) => item.sig === "stash.push"));
});

test("doc-examples: the canary set still covers both directions", () => {
  // The gate runs every example in its own process, which the sandboxed suite
  // (--permission, no spawn) cannot do -- so the vectors that prove a broken
  // example FAILS live in the gate itself, as canaries it runs before judging
  // anything. What is guarded here is that the set has not been hollowed out:
  // canaries in one direction only would let the gate pass everything, or fail
  // everything, and still look green from this file.
  assert.ok(CANARIES.some((c) => c.expect === "ran"));
  assert.ok(CANARIES.filter((c) => c.expect === "fail").length >= 4);
  assert.ok(CANARIES.every((c) => c.label && c.body));
  // The one that cannot be caught by importing a module and watching for a
  // throw: the failure lands after the import has already resolved.
  assert.ok(CANARIES.some((c) => c.expect === "fail" && c.body.includes("node:test")));
});

test("doc-examples: the generated module wraps the body and injects the world", () => {
  const source = buildExampleModule("const stash = 1;\nstash + 1;");
  // A function body, not module top level: an example that declares its own
  // `const stash` or a `var` must shadow the ambient binding, not collide.
  assert.match(source, /await \(async \(\) => \{/);
  assert.match(source, /const \{ [^}]*\bstash\b[^}]*\} = __world\.bindings;/);
  assert.match(source, /finally \{ await __world\.close\(\); \}/);
});

test("doc-examples: there is no verdict that skips execution", { skip: SANDBOXED }, (t) => {
  // Every example either runs or fails. A body that names an environment it
  // wants instead of running -- the shape of an opt-out -- gets no special
  // treatment, and one whose only content is a leading comment fails on the
  // statement check like any other prose-only body.
  const dir = exampleDir(t);
  const outcomes = new Set(
    [
      "// requires: a store already opened by the host application\nawait stash.close();",
      "const entry = await stash.show(ref);\nentry.size;",
    ].map((body, i) => runExample({ sig: "vector.noskip" + i, index: 1, body }, dir).outcome),
  );
  assert.deepEqual([...outcomes], ["ran"]);

  const prose = runExample(
    { sig: "vector.prose", index: 1, body: "// requires: a store, and nothing else" },
    dir,
  );
  assert.equal(prose.outcome, "fail");
  assert.match(prose.error, /no executable statement/);
});

test("doc-examples: @exampleFile cannot silently opt a primitive out of execution", (t) => {
  // The comment-block validator accepts @exampleFile in place of @example. This
  // gate cannot run one, so it has to say so rather than pass over it.
  const result = runExample(
    { sig: "vector.file", index: 1, body: "", unrunnable: "documents itself with @exampleFile" },
    exampleDir(t),
  );
  assert.equal(result.outcome, "fail");
  assert.match(result.error, /@exampleFile/);
});

test("doc-examples: an import of an unpublished subpath fails the gate", () => {
  assert.throws(
    () => buildExampleModule('import { X } from "@blamejs/stash/backends/nosuchbackend";'),
    /does not publish/,
  );
  assert.throws(
    () => buildExampleModule('import x from "some-other-package";'),
    /does not publish/,
  );
});

test("doc-examples: an example must import by package name, not by path", () => {
  // A relative import resolves only from inside this checkout, so a reader who
  // copies the example gets a broken line.
  assert.throws(
    () => buildExampleModule('import { Stash } from "../src/index.js";'),
    /published package name/,
  );
});

test("doc-examples: an import that cannot be hoisted is refused by name", () => {
  assert.throws(
    () => buildExampleModule('import {\n  Stash,\n} from "@blamejs/stash";'),
    /cannot hoist/,
  );
});

test("doc-examples: node builtins pass through untouched", () => {
  const source = buildExampleModule('import { test } from "node:test";\ntest("x", () => {});');
  assert.match(source, /import \{ test \} from "node:test"/);
});

test("doc-examples: import expressions stay in the body and still resolve", () => {
  // `import(...)` and `import.meta` are expressions, not declarations. Hoisting
  // them would be wrong, and refusing them would block a legitimate example --
  // but a dynamic specifier still has to resolve like every other one.
  const source = buildExampleModule(
    'const mod = await import("@blamejs/stash");\nimport.meta.url;\nmod.Stash;',
  );
  assert.doesNotMatch(source, /^import\("/m, "a dynamic import must not be hoisted");
  assert.match(source, /await import\("file:\/\/[^"]*src\/index\.js"\)/);
  assert.match(source, /import\.meta\.url;/);
  // The doc rule holds for a dynamic specifier too.
  assert.throws(() => buildExampleModule('await import("../src/index.js");'), /package name/);
});

test("doc-examples: an empty parse is a finding, not a pass", () => {
  assert.equal(
    quietly(() => report({ total: 0, ran: 0, failures: [] })),
    1,
  );
  assert.equal(
    quietly(() => report({ total: 3, ran: 3, failures: [] })),
    0,
  );
  assert.equal(
    quietly(() => report({ total: 3, ran: 2, failures: [{ sig: "s", index: 1, error: "boom" }] })),
    1,
  );
});

test("doc-examples: a canary that stopped discriminating fails the gate", () => {
  // The gate is only worth its exit code while it can still tell the two apart.
  assert.equal(
    quietly(() =>
      report({
        total: 0,
        ran: 0,
        failures: [],
        brokenCanaries: ["a renamed method: expected to fail, got ran"],
      }),
    ),
    1,
  );
});

test(
  "doc-examples: the gate consults its canaries before judging anything",
  { skip: SANDBOXED },
  () => {
    // Hand the real gate one canary whose expected verdict is wrong. If it still
    // runs the canaries, it notices and refuses to report on the examples; if the
    // wiring is ever cut, this comes back clean and every run stays green.
    const result = runExamples([
      {
        label: "a body that throws",
        expect: "ran",
        body: 'throw new Error("this must not pass");',
      },
    ]);
    assert.deepEqual(result.brokenCanaries, ["a body that throws: expected to ran, got fail"]);
    assert.equal(result.total, 0, "a gate that cannot discriminate judges nothing");
    assert.equal(result.canaries, 1);
    assert.equal(
      quietly(() => report(result)),
      1,
    );
  },
);

test("doc-examples: an example whose body executes nothing is refused", () => {
  // Deleting the code and keeping the prose would otherwise be the cheapest way
  // past a red gate, and it would be counted as executed.
  assert.throws(
    () => buildExampleModule("// Drop the entry the ref names.\n// The ref is spent afterwards."),
    /no executable statement/,
  );
  assert.throws(() => buildExampleModule("/* only a block comment */"), /no executable statement/);
  // An import names where a symbol comes from; it never shows it being used.
  assert.throws(
    () => buildExampleModule('import { Stash } from "@blamejs/stash";'),
    /no executable statement/,
  );
});
