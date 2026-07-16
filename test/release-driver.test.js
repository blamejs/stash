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

import { checksVerdict, reviewDecision } from "../scripts/release.js";

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

// ---------------------------------------------------------------------------
// reviewDecision -- reviewer verdict over reviews, inline review comments,
// and issue comments for the PR head commit
// ---------------------------------------------------------------------------

const HEAD = "a1b2c3d4e5f60718293645546372819a0bcdef12";
const OLD = "9999999888888877777776666666555555444444";
const BOT = "chatgpt-codex-connector[bot]";

test("reviewDecision: inline P1 anchored to the head commit blocks", () => {
  const v = reviewDecision(HEAD, {
    reviews: [{ author: BOT, body: "Reviewed commit: `" + HEAD.slice(0, 10) + "`" }],
    inline: [{ author: BOT, body: "P1 Badge: import the symbol before use", commit: HEAD }],
  });
  assert.equal(v.state, "findings");
});

test("reviewDecision: inline P2 citing the head sha in its body blocks", () => {
  const v = reviewDecision(HEAD, {
    reviews: [{ author: BOT, body: "Reviewed commit: `" + HEAD.slice(0, 10) + "`" }],
    inline: [{ author: BOT, body: "P2 finding on " + HEAD.slice(0, 7) }],
  });
  assert.equal(v.state, "findings");
});

test("reviewDecision: a later clean post never erases inline findings on the head", () => {
  const v = reviewDecision(HEAD, {
    comments: [{ author: BOT, body: "looks fine now, re: " + HEAD.slice(0, 7) }],
    inline: [{ author: BOT, body: "P1 Badge: fail-open verdict", commit: HEAD }],
  });
  assert.equal(v.state, "findings");
});

test("reviewDecision: review citing the head with no findings is clean", () => {
  const v = reviewDecision(HEAD, {
    reviews: [{ author: BOT, body: "Reviewed commit: `" + HEAD.slice(0, 10) + "`" }],
  });
  assert.equal(v.state, "clean");
});

test("reviewDecision: stale inline finding on a previous commit does not block the new head", () => {
  const v = reviewDecision(HEAD, {
    reviews: [{ author: BOT, body: "Reviewed commit: `" + HEAD.slice(0, 10) + "`" }],
    inline: [{ author: BOT, body: "P1 Badge: fixed since", commit: OLD }],
  });
  assert.equal(v.state, "clean");
});

test("reviewDecision: issue comment from the reviewer citing the head with a P1 blocks", () => {
  const v = reviewDecision(HEAD, {
    comments: [{ author: BOT, body: "P1 on " + HEAD.slice(0, 7) + ": verify path" }],
  });
  assert.equal(v.state, "findings");
});

test("reviewDecision: no surface citing the head stays pending", () => {
  assert.equal(reviewDecision(HEAD, {}).state, "pending");
  assert.equal(reviewDecision(HEAD, {
    reviews: [{ author: BOT, body: "Reviewed commit: `" + OLD.slice(0, 10) + "`" }],
  }).state, "pending");
});

test("reviewDecision: a non-reviewer post citing the head is not a verdict", () => {
  const v = reviewDecision(HEAD, {
    reviews: [{ author: "release-operator", body: "self-review of " + HEAD }],
    comments: [{ author: "release-operator", body: "ship " + HEAD.slice(0, 7) }],
  });
  assert.equal(v.state, "pending");
});

test("reviewDecision: P3-only review citing the head is clean (advisory, not a gate)", () => {
  const v = reviewDecision(HEAD, {
    reviews: [{ author: BOT, body: "Reviewed commit: `" + HEAD.slice(0, 10) + "` P3 style nit" }],
  });
  assert.equal(v.state, "clean");
});

test("reviewDecision: a missing or truncated head sha throws instead of matching everything", () => {
  assert.throws(() => reviewDecision("", { reviews: [{ author: BOT, body: "anything" }] }), TypeError);
  assert.throws(() => reviewDecision(undefined, {}), TypeError);
  assert.throws(() => reviewDecision("abc12", {}), TypeError);
});

test("reviewDecision: an author merely containing the reviewer name is not the reviewer", () => {
  for (const spoof of ["codexfan", "my-codex-mirror[bot]", "Codex"]) {
    const v = reviewDecision(HEAD, {
      reviews: [{ author: spoof, body: "Looks good. Reviewed commit: `" + HEAD.slice(0, 10) + "`" }],
    });
    assert.equal(v.state, "pending", spoof + " must not mint a verdict");
  }
});

test("reviewDecision: both reviewer identity forms are trusted", () => {
  for (const login of ["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"]) {
    const v = reviewDecision(HEAD, {
      reviews: [{ author: login, body: "Reviewed commit: `" + HEAD.slice(0, 10) + "` -- no findings." }],
    });
    assert.equal(v.state, "clean");
  }
});

