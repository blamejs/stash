// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Release-driver verdict vectors. The merge gate in scripts/release.js is
// a whitelist: only an explicitly passing check state and an explicit
// reviewer verdict for the PR head may unblock a merge; every terminal
// failure mode, every unknown state, and every entry shape the gate cannot
// read must block or wait. These vectors drive the exported pure verdict
// functions directly -- no process is spawned, so the suite holds under
// the sandboxed --permission run.

import { test } from "node:test";
import assert from "node:assert/strict";

import { checksVerdict } from "../scripts/release.js";

// ---------------------------------------------------------------------------
// checksVerdict -- CheckRun entries (status / conclusion)
// ---------------------------------------------------------------------------

test("checksVerdict: SUCCESS check run passes", () => {
  const v = checksVerdict([{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]);
  assert.equal(v.green, true);
  assert.deepEqual(v.blocking, []);
});

test("checksVerdict: SKIPPED and NEUTRAL check runs pass (deliberate no-op verdicts)", () => {
  const v = checksVerdict([
    { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "path-filtered", status: "COMPLETED", conclusion: "SKIPPED" },
    { name: "advisory", status: "COMPLETED", conclusion: "NEUTRAL" },
  ]);
  assert.equal(v.green, true);
  assert.deepEqual(v.blocking, []);
});

for (const conclusion of ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]) {
  test("checksVerdict: terminal " + conclusion + " check run blocks", () => {
    const v = checksVerdict([{ name: "ci", status: "COMPLETED", conclusion }]);
    assert.equal(v.green, false);
    assert.equal(v.blocking.length, 1);
    assert.match(v.blocking[0], /ci/);
    assert.match(v.blocking[0], new RegExp(conclusion));
  });
}

test("checksVerdict: unknown terminal conclusion blocks (whitelist, not enumeration)", () => {
  const v = checksVerdict([{ name: "ci", status: "COMPLETED", conclusion: "SOMETHING_NEW" }]);
  assert.equal(v.green, false);
  assert.equal(v.blocking.length, 1);
});

test("checksVerdict: completed run with no conclusion blocks", () => {
  const v = checksVerdict([{ name: "ci", status: "COMPLETED", conclusion: null }]);
  assert.equal(v.green, false);
  assert.equal(v.blocking.length, 1);
});

test("checksVerdict: lowercase terminal conclusion still blocks", () => {
  const v = checksVerdict([{ name: "ci", status: "completed", conclusion: "cancelled" }]);
  assert.equal(v.green, false);
  assert.equal(v.blocking.length, 1);
});

for (const status of ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING"]) {
  test("checksVerdict: " + status + " check run waits, never passes", () => {
    const v = checksVerdict([{ name: "ci", status, conclusion: null }]);
    assert.equal(v.green, false);
    assert.deepEqual(v.blocking, []);
    assert.equal(v.pending, 1);
  });
}

// ---------------------------------------------------------------------------
// checksVerdict -- StatusContext entries (state)
// ---------------------------------------------------------------------------

test("checksVerdict: SUCCESS status context passes", () => {
  const v = checksVerdict([{ context: "external/gate", state: "SUCCESS" }]);
  assert.equal(v.green, true);
  assert.deepEqual(v.blocking, []);
});

for (const state of ["FAILURE", "ERROR"]) {
  test("checksVerdict: " + state + " status context blocks", () => {
    const v = checksVerdict([{ context: "external/gate", state }]);
    assert.equal(v.green, false);
    assert.equal(v.blocking.length, 1);
    assert.match(v.blocking[0], /external\/gate/);
  });
}

for (const state of ["PENDING", "EXPECTED"]) {
  test("checksVerdict: " + state + " status context waits, never passes", () => {
    const v = checksVerdict([{ context: "external/gate", state }]);
    assert.equal(v.green, false);
    assert.deepEqual(v.blocking, []);
    assert.equal(v.pending, 1);
  });
}

test("checksVerdict: unknown status context state blocks", () => {
  const v = checksVerdict([{ context: "external/gate", state: "MYSTERY" }]);
  assert.equal(v.green, false);
  assert.equal(v.blocking.length, 1);
});

// ---------------------------------------------------------------------------
// checksVerdict -- shape and aggregate behavior
// ---------------------------------------------------------------------------

test("checksVerdict: entry matching neither shape blocks (unreadable is never a pass)", () => {
  const v = checksVerdict([{ name: "mystery" }]);
  assert.equal(v.green, false);
  assert.equal(v.blocking.length, 1);
});

test("checksVerdict: empty rollup is not green (checks absent is not checks passed)", () => {
  const v = checksVerdict([]);
  assert.equal(v.green, false);
  assert.deepEqual(v.blocking, []);
});

test("checksVerdict: non-array rollup is not green", () => {
  assert.equal(checksVerdict(null).green, false);
  assert.equal(checksVerdict(undefined).green, false);
});

test("checksVerdict: one blocking entry poisons an otherwise green rollup", () => {
  const v = checksVerdict([
    { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
    { context: "external/gate", state: "SUCCESS" },
    { name: "e2e", status: "COMPLETED", conclusion: "CANCELLED" },
  ]);
  assert.equal(v.green, false);
  assert.equal(v.blocking.length, 1);
  assert.match(v.blocking[0], /e2e/);
});

test("checksVerdict: mixed shapes all green with one pending stays not-green", () => {
  const v = checksVerdict([
    { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
    { context: "external/gate", state: "PENDING" },
  ]);
  assert.equal(v.green, false);
  assert.deepEqual(v.blocking, []);
  assert.equal(v.pending, 1);
});
