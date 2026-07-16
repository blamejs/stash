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

import { test } from "node:test";
import assert from "node:assert/strict";

import { diffSnapshot, isClean } from "../scripts/check-api-snapshot.js";

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

