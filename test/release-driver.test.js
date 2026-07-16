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

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { checksVerdict, mergeArgs, reviewDecision, tagFromState } from "../scripts/release.js";

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
// allow:ai-attribution -- the reviewer service's account login (identity fixture)
const BOT = "chatgpt-codex-connector[bot]";

test("reviewDecision: inline P1 anchored to the head commit blocks", () => {
  const v = reviewDecision(HEAD, {
    reviews: [{ author: BOT, body: "Reviewed commit: `" + HEAD.slice(0, 10) + "`" }],
    inline: [{ author: BOT, body: "P1 Badge: import the symbol before use", commit: HEAD }],
  });
  assert.equal(v.state, "findings");
});

test("reviewDecision: inline P2 anchored to the head commit blocks", () => {
  const v = reviewDecision(HEAD, {
    reviews: [{ author: BOT, body: "Reviewed commit: `" + HEAD.slice(0, 10) + "`", commit: HEAD }],
    inline: [{ author: BOT, body: "P2 finding here", commit: HEAD }],
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

test("reviewDecision: review on the head with no findings is clean", () => {
  const v = reviewDecision(HEAD, {
    reviews: [{ author: BOT, body: "Reviewed commit: `" + HEAD.slice(0, 10) + "`", commit: HEAD }],
  });
  assert.equal(v.state, "clean");
});

test("reviewDecision: stale inline finding on a previous commit does not block the new head", () => {
  const v = reviewDecision(HEAD, {
    reviews: [{ author: BOT, body: "Reviewed commit: `" + HEAD.slice(0, 10) + "`", commit: HEAD }],
    inline: [{ author: BOT, body: "P1 Badge: fixed since", commit: OLD }],
  });
  assert.equal(v.state, "clean");
});

test("reviewDecision: issue comment from the reviewer naming the full head with a P1 blocks", () => {
  const v = reviewDecision(HEAD, {
    comments: [{ author: BOT, body: "P1 on " + HEAD + ": verify path" }],
  });
  assert.equal(v.state, "findings");
});

test("reviewDecision: no surface on the head stays pending", () => {
  assert.equal(reviewDecision(HEAD, {}).state, "pending");
  assert.equal(reviewDecision(HEAD, {
    reviews: [{ author: BOT, body: "Reviewed commit: `" + OLD.slice(0, 10) + "`", commit: OLD }],
  }).state, "pending");
});

test("reviewDecision: a short-SHA collision does not satisfy the gate", () => {
  // A stale post reviewed a DIFFERENT commit whose first 7 hex chars happen
  // to match the new head. It carries the old full commit and only the
  // colliding short prefix in its body -- it must NOT count as on the head.
  const COLLIDER = HEAD.slice(0, 7) + "ffffffffffffffffffffffffffffffffff";
  const cleanReview = { author: BOT, body: "Reviewed `" + HEAD.slice(0, 10) + "`", commit: HEAD };
  // A stale P1 whose body cites only the 7-char prefix and whose commit is
  // the collider must not turn a clean head into findings.
  const staleFinding = { author: BOT, body: "P1 on " + HEAD.slice(0, 7), commit: COLLIDER };
  const v = reviewDecision(HEAD, { reviews: [cleanReview], inline: [staleFinding] });
  assert.equal(v.state, "clean");
  // And a stale finding alone (no genuine head review) stays pending, never findings.
  const v2 = reviewDecision(HEAD, { inline: [staleFinding], comments: [{ author: BOT, body: "P1 on " + HEAD.slice(0, 7) }] });
  assert.equal(v2.state, "pending");
});

test("reviewDecision: a non-reviewer post citing the head is not a verdict", () => {
  const v = reviewDecision(HEAD, {
    reviews: [{ author: "release-operator", body: "self-review of " + HEAD }],
    comments: [{ author: "release-operator", body: "ship " + HEAD.slice(0, 7) }],
  });
  assert.equal(v.state, "pending");
});

test("reviewDecision: P3-only review on the head is clean (advisory, not a gate)", () => {
  const v = reviewDecision(HEAD, {
    reviews: [{ author: BOT, body: "Reviewed commit: `" + HEAD.slice(0, 10) + "` P3 style nit", commit: HEAD }],
  });
  assert.equal(v.state, "clean");
});

test("reviewDecision: a missing or truncated head sha throws instead of matching everything", () => {
  assert.throws(() => reviewDecision("", { reviews: [{ author: BOT, body: "anything" }] }), TypeError);
  assert.throws(() => reviewDecision(undefined, {}), TypeError);
  assert.throws(() => reviewDecision("abc12", {}), TypeError);
});

test("reviewDecision: inline P0 anchored to the head commit blocks (highest severity)", () => {
  const v = reviewDecision(HEAD, {
    reviews: [{ author: BOT, body: "Reviewed commit: `" + HEAD.slice(0, 10) + "`" }],
    inline: [{ author: BOT, body: "P0 Badge: this must never merge", commit: HEAD }],
  });
  assert.equal(v.state, "findings");
});

test("reviewDecision: an issue comment naming the full head with a P0 blocks", () => {
  const v = reviewDecision(HEAD, {
    comments: [{ author: BOT, body: "P0 on `" + HEAD + "`: release blocker" }],
  });
  assert.equal(v.state, "findings");
});

// The merge is requested inside the poll loop, but success is claimed only
// by an observed state === "MERGED" at the top of the loop: `gh pr merge`
// on a merge-queue base branch enqueues and returns without merging, so
// treating the call as immediate success would sync a stale main and tag a
// pre-merge commit. This pins that control-flow contract at the source.
test("cmdWatch claims merged only from an observed MERGED state, never from the merge call", () => {
  const rawSrc = readFileSync(new URL("../scripts/release.js", import.meta.url), "utf8");
  // Strip line and block comments so prose mentioning the mechanism cannot
  // satisfy or trip the structural assertions -- only real code counts.
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const start = src.indexOf("function cmdWatch");
  assert.ok(start !== -1, "cmdWatch must exist");
  const end = src.indexOf("\nfunction ", start + 1);
  const body = src.slice(start, end === -1 ? undefined : end);

  // Exactly one `merged = true`, and it sits in the state === "MERGED" arm.
  const assigns = body.match(/merged\s*=\s*true/g) || [];
  assert.equal(assigns.length, 1, "cmdWatch must set merged=true in exactly one place");
  const mergedCheck = body.indexOf('state === "MERGED"');
  const assignAt = body.indexOf("merged = true");
  assert.ok(mergedCheck !== -1 && assignAt !== -1);
  assert.ok(assignAt - mergedCheck > 0 && assignAt - mergedCheck < 80,
    "merged=true must be set by the observed MERGED state check, not elsewhere");

  // The merge call must NOT be immediately followed by success/cleanup: no
  // `merged = true` or `break` in the block that fires the merge.
  const mergeCall = body.indexOf("mergeArgs(branch");
  assert.ok(mergeCall !== -1, "cmdWatch must call gh with mergeArgs");
  const afterMerge = body.slice(mergeCall, mergeCall + 220);
  assert.ok(!/merged\s*=\s*true/.test(afterMerge),
    "the merge call must not claim success -- a queued merge lands asynchronously");
  assert.ok(!/\bbreak\b/.test(afterMerge),
    "the merge call must not break out of the poll loop before observing MERGED");
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
  // allow:ai-attribution -- the reviewer service's account logins (identity fixture)
  for (const login of ["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"]) {
    const v = reviewDecision(HEAD, {
      reviews: [{ author: login, body: "Reviewed -- no findings.", commit: HEAD }],
    });
    assert.equal(v.state, "clean");
  }
});

// ---------------------------------------------------------------------------
// cmdPrepare -- source contract: branch first, version write second
// ---------------------------------------------------------------------------

test("cmdPrepare creates the release branch before writing package.json", () => {
  // Frozen control-flow contract: if the branch cannot be created (it
  // already exists), prepare must fail while main is still clean. A
  // version write that precedes the checkout leaves a dirty main on
  // failure and every retry needs manual cleanup.
  const src = readFileSync(new URL("../scripts/release.js", import.meta.url), "utf8");
  const start = src.indexOf("function cmdPrepare");
  const end = src.indexOf("function cmdPush");
  assert.ok(start !== -1 && end > start, "cmdPrepare and cmdPush must both exist");
  const body = src.slice(start, end);
  const branchAt = body.indexOf('"checkout", "-b"');
  const writeAt = body.indexOf('writeFileSync(join(ROOT, "package.json")');
  assert.ok(branchAt !== -1, "cmdPrepare must create the release branch");
  assert.ok(writeAt !== -1, "cmdPrepare must write the bumped package.json");
  assert.ok(branchAt < writeAt,
    "create the release branch BEFORE writing package.json -- a failed checkout must leave main clean");
});
// ---------------------------------------------------------------------------
// mergeArgs -- the merge is bound to the sha the verdict was computed for
// ---------------------------------------------------------------------------

test("mergeArgs: the merge is bound to the reviewed head commit", () => {
  const args = mergeArgs("release-v0.1.4", HEAD);
  assert.deepEqual(args, ["pr", "merge", "release-v0.1.4", "--squash", "--match-head-commit", HEAD]);
});

test("mergeArgs: a missing or truncated head sha throws instead of merging unbound", () => {
  assert.throws(() => mergeArgs("release-v0.1.4", undefined), TypeError);
  assert.throws(() => mergeArgs("release-v0.1.4", "a1b2c"), TypeError);
});


// ---------------------------------------------------------------------------
// tagFromState -- the signed tag pins the release PR's version AND merge commit
// ---------------------------------------------------------------------------

const SHA = "a1b2c3d4e5f60718293645546372819a0bcdef12";

test("tagFromState: recorded version + merge commit are the tag plan", () => {
  assert.deepEqual(tagFromState({ version: "0.1.4", mergeSha: SHA }), { version: "0.1.4", target: SHA });
});

test("tagFromState: absent / malformed state falls back to HEAD (null)", () => {
  assert.equal(tagFromState(null), null);
  assert.equal(tagFromState({}), null);
  assert.equal(tagFromState({ version: "0.1.4" }), null);
  assert.equal(tagFromState({ mergeSha: SHA }), null);
  assert.equal(tagFromState({ version: "not.a.version", mergeSha: SHA }), null);
  assert.equal(tagFromState({ version: "0.1.4", mergeSha: "not-a-sha" }), null);
  assert.equal(tagFromState({ version: "0.1.4", mergeSha: "" }), null);
});

// cmdWatch captures the release branch's version BEFORE syncing main and
// records it with the merge commit; cmdTag pins BOTH. A concurrent PR that
// bumps package.json or advances main after our merge can therefore neither
// mis-version nor mis-target the tag. Structural, over comment-stripped source.
test("cmdTag pins the tag version + commit from the recorded state, not the post-sync tree", () => {
  const raw = readFileSync(new URL("../scripts/release.js", import.meta.url), "utf8");
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  const tagStart = src.indexOf("function cmdTag");
  const tagEnd = src.indexOf("\nfunction ", tagStart + 1);
  const tagBody = src.slice(tagStart, tagEnd === -1 ? undefined : tagEnd);
  assert.ok(/tagFromState\s*\(/.test(tagBody), "cmdTag must resolve version + target via tagFromState");
  assert.ok(/planned\s*\?\s*planned\.version/.test(tagBody),
    "cmdTag must take the version from the recorded plan when present");
  assert.ok(/tagArgs\.push\(\s*target\s*\)/.test(tagBody),
    "cmdTag must append the resolved target to the git tag args");

  const watchStart = src.indexOf("function cmdWatch");
  const watchEnd = src.indexOf("\nfunction ", watchStart + 1);
  const watchBody = src.slice(watchStart, watchEnd === -1 ? undefined : watchEnd);
  assert.ok(/mergeCommit/.test(watchBody), "cmdWatch must request the PR mergeCommit");
  // The version must be captured before the pull that syncs main.
  const verAt = watchBody.indexOf("readVersion()");
  const pullAt = watchBody.indexOf('"pull"');
  assert.ok(verAt !== -1 && pullAt !== -1 && verAt < pullAt,
    "cmdWatch must read the release version BEFORE the pull that syncs main");
  assert.ok(/writeFileSync\(\s*releaseStatePath\(\)[\s\S]*releaseVersion/.test(watchBody),
    "cmdWatch must record the pre-sync releaseVersion with the merge commit");
});
