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

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { diffSnapshot, isClean } from "../scripts/check-api-snapshot.js";
import { loadNotes, render } from "../scripts/regen-changelog.js";
import * as engine from "../examples/wiki/lib/source-comment-block-validator.js";
import * as parser from "../examples/wiki/lib/source-doc-parser.js";
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
  assert.match(diffSnapshot(snapshotFixture(), removed, "1.0.0").breaking[0], /index\.version: removed/);

  const rekinded = snapshotFixture();
  rekinded.surface.index.members.version = { kind: "number" };
  assert.match(diffSnapshot(snapshotFixture(), rekinded, "1.0.0").breaking[0], /kind changed string -> number/);

  const rearitied = snapshotFixture();
  rearitied.surface.index.members.Stash.methods.push.arity = 3;
  assert.match(diffSnapshot(snapshotFixture(), rearitied, "1.0.0").breaking[0], /arity changed 2 -> 3/);

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
  assert.deepEqual(notes.map((n) => n.version), ["0.1.1", "0.1.0"]);
});

// ---------------------------------------------------------------------------
// source-comment-block validate() -- empty-parse floor
// ---------------------------------------------------------------------------

test("comment-blocks: an empty parse is a finding, not a pass", (t) => {
  const dir = freshScratchDir("empty-lib");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const findings = engine.validate({ libDir: dir, parser, requireSpec: true });
  assert.ok(findings.length >= 1, "zero findings on a tree with zero documented files is fail-open");
  assert.match(findings[0].msg, /no documented source files/);
});
