// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Release-driver verdict vectors. The merge gate in scripts/release.js is a
// whitelist: only an explicitly passing check state and zero unresolved
// review threads for the PR head may unblock a merge; every terminal check
// failure, every unknown state, and every entry shape the gate cannot read
// must block or wait. These vectors drive the exported pure verdict functions
// directly -- no process is spawned, so the suite holds under the sandboxed
// --permission run.

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { checksVerdict, collectAllPages, mergeArgs, reviewerSignalsReview, reviewTriggerForHead, syncLockfileVersion, tagFromState, unresolvedThreads } from "../scripts/release.js";

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
// unresolvedThreads -- the pure merge gate over the reviewThreads node array.
// GitHub's review-thread isResolved state is the authoritative signal (the
// exact one required_review_thread_resolution enforces): an inline finding's
// commit_id is re-anchored to the head after every push, so a fixed-but-stale
// finding still reads "on the head" and would block forever if the gate keyed
// on it; isResolved flips only on an API resolve, so it is the stable truth.
// ---------------------------------------------------------------------------

test("unresolvedThreads: an unresolved thread blocks (non-empty result)", () => {
  const out = unresolvedThreads([
    {
      id: "PRRT_1", isResolved: false, path: "src/x.js", line: 10,
      comments: { nodes: [{ author: { login: "reviewer" }, body: "P1: fix this" }] },
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "PRRT_1");
  assert.equal(out[0].path, "src/x.js");
  assert.equal(out[0].line, 10);
  assert.equal(out[0].author, "reviewer");
});

test("unresolvedThreads: all-resolved clears (empty result)", () => {
  const out = unresolvedThreads([
    { id: "PRRT_1", isResolved: true, path: "src/x.js", comments: { nodes: [{ author: { login: "reviewer" }, body: "done" }] } },
    { id: "PRRT_2", isResolved: true, path: "src/y.js", comments: { nodes: [] } },
  ]);
  assert.deepEqual(out, []);
});

test("unresolvedThreads: mixed -- only the unresolved thread blocks", () => {
  const out = unresolvedThreads([
    { id: "PRRT_1", isResolved: true },
    { id: "PRRT_2", isResolved: false, comments: { nodes: [{ author: { login: "reviewer" }, body: "still open" }] } },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "PRRT_2");
  assert.equal(out[0].path, "(pr-level)"); // a thread with no path is labelled pr-level
});

test("unresolvedThreads: a genuinely empty thread list clears (a real [] is the PASS value)", () => {
  assert.deepEqual(unresolvedThreads([]), []);
});

test("unresolvedThreads: a failed/absent query (a non-array) throws -- fail closed", () => {
  // [] is this gate's PASS value, so an unreadable result -- null/undefined
  // from a broken query, or a non-array shape -- must throw, never read as
  // "no threads block".
  assert.throws(() => unresolvedThreads(null), TypeError);
  assert.throws(() => unresolvedThreads(undefined), TypeError);
  assert.throws(() => unresolvedThreads("[]"), TypeError);
  assert.throws(() => unresolvedThreads({ nodes: [] }), TypeError);
});

// ---------------------------------------------------------------------------
// cmdWatch -- gate only, never merges. The merge + sync + tag-target record
// live in cmdMerge; watch must not mutate the repo.
// ---------------------------------------------------------------------------

test("cmdWatch is a pure gate: it never merges or syncs (no mergeArgs / checkout main)", () => {
  const raw = readFileSync(new URL("../scripts/release.js", import.meta.url), "utf8");
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const start = src.indexOf("function cmdWatch");
  assert.ok(start !== -1, "cmdWatch must exist");
  const end = src.indexOf("\nfunction ", start + 1);
  const body = src.slice(start, end === -1 ? undefined : end);
  assert.ok(!/mergeArgs\s*\(/.test(body), "cmdWatch must not merge -- that belongs to cmdMerge");
  assert.ok(!/"checkout",\s*"main"/.test(body), "cmdWatch must not sync main -- it only gates");
  // It still fails closed on an unresolved thread: it prints them and exits.
  assert.ok(/fetchUnresolvedThreads\s*\(/.test(body), "cmdWatch must read the thread gate");
  assert.ok(/printUnresolvedThreads\s*\(/.test(body) && /process\.exit\(/.test(body),
    "an unresolved thread must print + exit non-zero");
});

// ---------------------------------------------------------------------------
// cmdMerge -- the mutating half: merge bound to the reviewed head, then sync.
// The merge is requested inside the poll, but success is claimed only by an
// observed state === "MERGED": `gh pr merge` on a merge-queue base branch
// enqueues and returns without merging, so treating the call as immediate
// success would sync a stale main and tag a pre-merge commit.
// ---------------------------------------------------------------------------

test("cmdMerge claims merged only from an observed MERGED state, never from the merge call", () => {
  const rawSrc = readFileSync(new URL("../scripts/release.js", import.meta.url), "utf8");
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const start = src.indexOf("function cmdMerge");
  assert.ok(start !== -1, "cmdMerge must exist");
  const end = src.indexOf("\nfunction ", start + 1);
  const body = src.slice(start, end === -1 ? undefined : end);

  // Exactly one `merged = true`, set right below an observed MERGED check.
  const assigns = body.match(/merged\s*=\s*true/g) || [];
  assert.equal(assigns.length, 1, "cmdMerge must set merged=true in exactly one place");
  const assignAt = body.indexOf("merged = true");
  const mergedCheckAt = body.lastIndexOf('"MERGED"', assignAt);
  assert.ok(assignAt !== -1 && mergedCheckAt !== -1);
  assert.ok(assignAt - mergedCheckAt < 80,
    "merged=true must be set by the observed MERGED state check, not elsewhere");

  // The merge call must be followed by a poll loop BEFORE any success claim.
  const mergeCall = body.indexOf("mergeArgs(branch");
  assert.ok(mergeCall !== -1, "cmdMerge must call gh with mergeArgs");
  const loopAfterMerge = body.indexOf("for (", mergeCall);
  assert.ok(loopAfterMerge !== -1 && loopAfterMerge < assignAt,
    "the merge call must be followed by a poll loop before merged=true -- a queued merge lands asynchronously");
  const immediate = body.slice(mergeCall, loopAfterMerge);
  assert.ok(!/merged\s*=\s*true/.test(immediate) && !/\bbreak\b/.test(immediate),
    "the merge call must not claim success before the poll");
});

// ---------------------------------------------------------------------------
// cmdPrepare -- source contract: branch first, then bump package.json AND the
// lockfile in lockstep (the CI lockfile-sync gate compares both).
// ---------------------------------------------------------------------------

test("cmdPrepare creates the release branch before writing package.json", () => {
  // Frozen control-flow contract: if the branch cannot be created (it already
  // exists), prepare must fail while main is still clean. A version write that
  // precedes the checkout leaves a dirty main on failure and every retry needs
  // manual cleanup.
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

test("cmdPrepare syncs package-lock.json to the bumped version in the same step", () => {
  // The lockfile-sync CI gate fails a cut whose package-lock.json still records
  // the previous release; prepare must rewrite the lockfile alongside the
  // package.json bump or every cut is blocked at PR time.
  const raw = readFileSync(new URL("../scripts/release.js", import.meta.url), "utf8");
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const start = src.indexOf("function cmdPrepare");
  const end = src.indexOf("\nfunction ", start + 1);
  const body = src.slice(start, end === -1 ? undefined : end);
  assert.ok(/syncLockfileVersion\s*\(/.test(body), "cmdPrepare must call syncLockfileVersion");
  assert.ok(/package-lock\.json/.test(body), "cmdPrepare must write package-lock.json");
  const pkgWriteAt = body.indexOf('writeFileSync(join(ROOT, "package.json")');
  const lockSyncAt = body.indexOf("syncLockfileVersion");
  assert.ok(pkgWriteAt !== -1 && lockSyncAt !== -1 && pkgWriteAt < lockSyncAt,
    "cmdPrepare must bump package.json, then sync the lockfile to the same version");
});

// ---------------------------------------------------------------------------
// syncLockfileVersion -- both version fields move to the bumped version.
// ---------------------------------------------------------------------------

test("syncLockfileVersion: both the top-level and root package versions move to the target", () => {
  const lock = {
    name: "@blamejs/stash", version: "0.1.3", lockfileVersion: 3, requires: true,
    packages: { "": { name: "@blamejs/stash", version: "0.1.3", license: "Apache-2.0" } },
  };
  const out = syncLockfileVersion(lock, "0.1.4");
  assert.equal(out.version, "0.1.4");
  assert.equal(out.packages[""].version, "0.1.4");
  // Untouched fields survive.
  assert.equal(out.name, "@blamejs/stash");
  assert.equal(out.lockfileVersion, 3);
  assert.equal(out.packages[""].license, "Apache-2.0");
});

test("syncLockfileVersion: the synced lockfile version equals the bumped package version", () => {
  // The CI gate compares lock.version AND packages[''].version to
  // package.json; both must equal the just-bumped version or the cut is
  // blocked (0.1.4 shipped a 0.1.3 lockfile against a 0.1.4 package.json).
  const pkgVersion = "0.2.0";
  const out = syncLockfileVersion({ version: "0.1.9", packages: { "": { version: "0.1.9" } } }, pkgVersion);
  assert.equal(out.version, pkgVersion);
  assert.equal(out.packages[""].version, pkgVersion);
});

test("syncLockfileVersion: rejects a bad lockfile object or version -- fail closed", () => {
  assert.throws(() => syncLockfileVersion(null, "0.1.4"), TypeError);
  assert.throws(() => syncLockfileVersion({}, "not.a.version"), TypeError);
  assert.throws(() => syncLockfileVersion({}, ""), TypeError);
});

test("syncLockfileVersion: does not mutate the input lockfile", () => {
  const lock = { version: "0.1.3", packages: { "": { version: "0.1.3" } } };
  syncLockfileVersion(lock, "0.1.4");
  assert.equal(lock.version, "0.1.3");
  assert.equal(lock.packages[""].version, "0.1.3");
});

// ---------------------------------------------------------------------------
// cmdPublish -- the registry verify is a bounded poll, not a one-shot read.
// ---------------------------------------------------------------------------

test("cmdPublish polls the registry after the workflow concludes, not a one-shot npm view", () => {
  // A cut published cleanly yet was declared a false FAIL: a single `npm view`
  // ran before the registry propagated. Success gates on the npm-publish
  // workflow-run conclusion; the registry verify must be a bounded poll so
  // propagation lag is not mistaken for a failed publish.
  const raw = readFileSync(new URL("../scripts/release.js", import.meta.url), "utf8");
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const start = src.indexOf("function cmdPublish");
  assert.ok(start !== -1, "cmdPublish must exist");
  const end = src.indexOf("\nfunction ", start + 1);
  const body = src.slice(start, end === -1 ? undefined : end);
  // Two poll loops: the workflow-run watch AND the registry propagation poll.
  const forLoops = (body.match(/for\s*\(/g) || []).length;
  assert.ok(forLoops >= 2, "cmdPublish must poll the registry in a loop, not a one-shot npm view");
  assert.ok(/"view"/.test(body), "cmdPublish must query the registry with npm view");
  assert.ok(/conclusion/.test(body), "cmdPublish must gate success on the publish run conclusion");
});

// ---------------------------------------------------------------------------
// mergeArgs -- the merge is bound to the sha the verdict was computed for
// ---------------------------------------------------------------------------

const HEAD = "a1b2c3d4e5f60718293645546372819a0bcdef12";

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

// cmdMerge captures the release branch's version BEFORE syncing main and
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

  const mergeStart = src.indexOf("function cmdMerge");
  const mergeEnd = src.indexOf("\nfunction ", mergeStart + 1);
  const mergeBody = src.slice(mergeStart, mergeEnd === -1 ? undefined : mergeEnd);
  assert.ok(/mergeCommit/.test(mergeBody), "cmdMerge must request the PR mergeCommit");
  // The version must be captured before the pull that syncs main.
  const verAt = mergeBody.indexOf("readVersion()");
  const pullAt = mergeBody.indexOf('"pull"');
  assert.ok(verAt !== -1 && pullAt !== -1 && verAt < pullAt,
    "cmdMerge must read the release version BEFORE the pull that syncs main");
  assert.ok(/writeFileSync\(\s*releaseStatePath\(\)[\s\S]*releaseVersion/.test(mergeBody),
    "cmdMerge must record the pre-sync releaseVersion with the merge commit");
});

// ---------------------------------------------------------------------------
// reviewerSignalsReview -- the reviewer signalled a review of the head via
// ANY of its three forms (review node, clean-verdict comment, or a bare
// THUMBS_UP reaction on the driver's trigger comment). The wait must not hang
// when the bot only reacts, and must not clear on a prior head's reaction.
// ---------------------------------------------------------------------------

const RHEAD = "a1b2c3d4e5f60718293645546372819a0bcdef12";
const RBOT = "chatgpt-codex-connector[bot]"; // allow:ai-attribution -- reviewer login fixture
// The thumbs-up form binds to the head by the IDENTITY of the trigger comment
// the driver posted for THIS head: only a bot reaction on comment TRIGGER_ID
// reviews this head; a reaction on any other (a prior head's trigger) does not.
const TRIGGER_ID = 4994188035; // the `@codex review` comment the driver posted for this head
const PRIOR_ID = 4990000001; // an earlier trigger comment, from a prior head

test("reviewerSignalsReview: a review node on the head counts (findings form)", () => {
  assert.equal(reviewerSignalsReview({ reviews: [{ author: RBOT, commit: RHEAD }] }, RHEAD), true);
});

test("reviewerSignalsReview: a clean-verdict comment citing the head counts", () => {
  assert.equal(reviewerSignalsReview({
    comments: [{ author: RBOT, body: "Reviewed `" + RHEAD.slice(0, 10) + "` -- no issues." }],
  }, RHEAD), true);
});

test("reviewerSignalsReview: a bot THUMBS_UP on the driver's trigger comment counts", () => {
  // The bot posts NO review node and NO comment -- only a thumbs-up reaction on
  // the trigger the driver created for this head. This is the case that
  // otherwise hangs the wait until it times out.
  assert.equal(reviewerSignalsReview({
    comments: [{
      author: "release-operator",
      body: "@codex review",
      databaseId: TRIGGER_ID,
      reactions: [{ content: "THUMBS_UP", login: RBOT }],
    }],
  }, RHEAD, TRIGGER_ID), true);
});

test("reviewerSignalsReview: a bot THUMBS_UP on a PRIOR head's trigger does NOT count", () => {
  // The reported P1: a clean thumbs-up on an earlier trigger must not clear the
  // wait after a fix/direct push makes a new head the bot has not reviewed. The
  // driver's trigger for the new head is TRIGGER_ID; a reaction on PRIOR_ID is a
  // different comment id and does not match.
  assert.equal(reviewerSignalsReview({
    comments: [{
      author: "release-operator",
      body: "@codex review",
      databaseId: PRIOR_ID,
      reactions: [{ content: "THUMBS_UP", login: RBOT }],
    }],
  }, RHEAD, TRIGGER_ID), false);
});

test("reviewerSignalsReview: a THUMBS_UP is unbindable (does NOT count) without a trigger id", () => {
  // A reaction carries no sha; absent the driver's trigger id it cannot be
  // bound to the head, so it fails closed rather than clearing on a stale one.
  const surfaces = {
    comments: [{ author: "op", body: "@codex review", databaseId: TRIGGER_ID, reactions: [{ content: "THUMBS_UP", login: RBOT }] }],
  };
  assert.equal(reviewerSignalsReview(surfaces, RHEAD), false);
  assert.equal(reviewerSignalsReview(surfaces, RHEAD, null), false);
});

test("reviewerSignalsReview: a THUMBS_UP on a comment with no databaseId does NOT count", () => {
  assert.equal(reviewerSignalsReview({
    comments: [{ author: "op", body: "@codex review", reactions: [{ content: "THUMBS_UP", login: RBOT }] }],
  }, RHEAD, TRIGGER_ID), false);
});

test("reviewerSignalsReview: a head-bound review node counts even with no trigger id", () => {
  // Forms (1) and (2) self-bind via the head sha and never need a trigger id.
  assert.equal(reviewerSignalsReview({ reviews: [{ author: RBOT, commit: RHEAD }] }, RHEAD), true);
  assert.equal(reviewerSignalsReview({
    comments: [{ author: RBOT, body: "Reviewed `" + RHEAD.slice(0, 10) + "` -- no issues." }],
  }, RHEAD), true);
});

test("reviewerSignalsReview: no signal at all stays false (keep waiting)", () => {
  assert.equal(reviewerSignalsReview({}, RHEAD, TRIGGER_ID), false);
  assert.equal(reviewerSignalsReview({ comments: [{ author: "someone", body: "hi" }] }, RHEAD, TRIGGER_ID), false);
});

test("reviewerSignalsReview: a THUMBS_UP on the trigger from a non-reviewer does not count", () => {
  assert.equal(reviewerSignalsReview({
    comments: [{ author: "op", body: "@codex review", databaseId: TRIGGER_ID, reactions: [{ content: "THUMBS_UP", login: "randomuser" }] }],
  }, RHEAD, TRIGGER_ID), false);
});

test("reviewerSignalsReview: a numeric trigger id matches a string databaseId (and vice versa)", () => {
  // gh REST returns the id as a number, GraphQL databaseId as a number, but a
  // string id must not silently miss -- the compare normalizes both.
  assert.equal(reviewerSignalsReview({
    comments: [{ author: "op", body: "@codex review", databaseId: String(TRIGGER_ID), reactions: [{ content: "THUMBS_UP", login: RBOT }] }],
  }, RHEAD, TRIGGER_ID), true);
});

test("reviewerSignalsReview: a missing head sha throws instead of matching everything", () => {
  assert.throws(() => reviewerSignalsReview({ reviews: [{ author: RBOT, commit: RHEAD }] }, ""), TypeError);
  assert.throws(() => reviewerSignalsReview({}, undefined), TypeError);
});

// ---------------------------------------------------------------------------
// collectAllPages -- accumulate a paginated GraphQL connection across EVERY
// page. A gate that reads only the first page treats a later page's open
// finding as absent; this must page through in full and fail closed on a
// partial read.
// ---------------------------------------------------------------------------

test("collectAllPages: a single page returns its nodes", () => {
  assert.deepEqual(collectAllPages(() => ({ nodes: [1, 2, 3], hasNextPage: false })), [1, 2, 3]);
});

test("collectAllPages: concatenates every page in order and threads the cursor", () => {
  const seen = [];
  const pages = {
    "": { nodes: ["a", "b"], hasNextPage: true, endCursor: "c1" },
    c1: { nodes: ["c"], hasNextPage: true, endCursor: "c2" },
    c2: { nodes: ["d"], hasNextPage: false },
  };
  const out = collectAllPages((cursor) => {
    seen.push(cursor);
    return pages[cursor || ""];
  });
  assert.deepEqual(out, ["a", "b", "c", "d"]);
  assert.deepEqual(seen, [null, "c1", "c2"]); // first page reads with null cursor, then follows endCursor
});

test("collectAllPages: an unreadable page fails closed (throws)", () => {
  assert.throws(() => collectAllPages(() => ({ nodes: null, hasNextPage: false })), /partial result/);
  assert.throws(() => collectAllPages(() => null), /partial result/);
});

test("collectAllPages: a next page promised with no cursor fails closed (throws)", () => {
  assert.throws(() => collectAllPages(() => ({ nodes: [1], hasNextPage: true, endCursor: null })), /no cursor/);
});

// ---------------------------------------------------------------------------
// reviewTriggerForHead -- recover a recorded trigger id ONLY for the exact head
// it was recorded against. The head match is the safety property: a prior
// head's trigger must never be revived to clear a head the reviewer has not
// seen (which would reintroduce the stale-reaction bug the id-binding closed).
// ---------------------------------------------------------------------------

test("reviewTriggerForHead: recovers the id recorded for the current head", () => {
  assert.equal(reviewTriggerForHead({ reviewTrigger: { head: RHEAD, id: TRIGGER_ID } }, RHEAD), TRIGGER_ID);
});

test("reviewTriggerForHead: does NOT recover a trigger recorded for a different head", () => {
  // A direct push moved the head; the recorded (prior-head) trigger must not be
  // reused, so the wait posts a fresh trigger for the new head instead.
  const priorHead = "b2c3d4e5f60718293645546372819a0bcdef1234";
  assert.equal(reviewTriggerForHead({ reviewTrigger: { head: priorHead, id: TRIGGER_ID } }, RHEAD), null);
});

test("reviewTriggerForHead: null on absent, malformed, or id-less records", () => {
  assert.equal(reviewTriggerForHead(null, RHEAD), null);
  assert.equal(reviewTriggerForHead({}, RHEAD), null);
  assert.equal(reviewTriggerForHead({ reviewTrigger: null }, RHEAD), null);
  assert.equal(reviewTriggerForHead({ reviewTrigger: { head: RHEAD } }, RHEAD), null);
  assert.equal(reviewTriggerForHead("not-an-object", RHEAD), null);
});
