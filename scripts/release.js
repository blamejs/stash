// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// release.js -- orchestrate the release flow as a sequence of idempotent
// subcommands. Each subcommand performs ONE phase, prints what it did,
// and exits with a code that is safe to script against. There are no
// confirmation prompts: the gates are the confirmation.
//
// Implemented today (local repository, no remote):
//   node scripts/release.js status    # version, git cleanliness, gate freshness
//   node scripts/release.js regen     # regen CHANGELOG.md + api-snapshot.json
//   node scripts/release.js smoke     # the full smoke pipeline
//   node scripts/release.js commit    # gates, then git add -A + signed commit
//   node scripts/release.js tag       # annotated signed tag v<version>
//   node scripts/release.js help      # this banner
//
// Remote-dependent phases (prepare, push, watch, merge, publish) exist as
// fail-loud placeholders: they refuse with a one-line message until a
// GitHub remote is configured, the same pattern the library applies to
// spec options whose milestone has not shipped.
//
// Pre-conditions:
//   - `commit` requires release-notes/v<package.json version>.json; the
//     headline / summary / sections need human judgment and do not
//     auto-generate from a diff. It refuses with a stub template printed
//     to stderr otherwise.
//   - Git SSH signing (commit.gpgsign, tag.gpgsign, allowed_signers) must
//     be configured before the first signed commit or tag.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REMOTE_ONLY = ["prepare", "push", "push-fix", "watch", "merge", "publish"]; // shown in status when no remote exists

function run(cmd, args, opts) {
  const input = opts && opts.input;
  const rv = spawnSync(cmd, args, {
    cwd: ROOT,
    // spawnSync delivers input only through a piped stdin; an inherited
    // stdin silently drops it and the child reads EOF.
    stdio: (opts && opts.stdio) || (input != null ? ["pipe", "inherit", "inherit"] : "inherit"),
    input,
    encoding: "utf8",
  });
  if (rv.status !== 0 && !(opts && opts.allowFail)) {
    throw new Error(cmd + " " + args.join(" ") + " failed with status " + rv.status);
  }
  return rv;
}

function capture(cmd, args) {
  const rv = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return {
    status: rv.status,
    stdout: (rv.stdout || "").trim(),
    stderr: (rv.stderr || "").trim(),
  };
}

function readVersion() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

function gitClean() {
  return capture("git", ["status", "--porcelain"]).stdout === "";
}

function gitBranch() {
  return capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
}

function releaseNotesPath(version) {
  return join(ROOT, "release-notes", "v" + version + ".json");
}

function readReleaseNotes(version) {
  let raw;
  try {
    raw = readFileSync(releaseNotesPath(version), "utf8");
  } catch {
    const stub = {
      version,
      date: new Date().toISOString().slice(0, 10),
      headline: "<one-line operator-facing summary>",
      summary: "<one-paragraph why-it-matters>",
      sections: { Added: ["<one operator-facing sentence per shipped surface>"] },
    };
    console.error("");
    console.error("release: missing " + releaseNotesPath(version));
    console.error("");
    console.error("Create that file before re-running. Stub template:");
    console.error("");
    console.error(JSON.stringify(stub, null, 2));
    console.error("");
    process.exit(2);
  }
  return JSON.parse(raw);
}

function section(title) {
  console.log("\n=== " + title + " ===");
}

function ok(msg) {
  console.log("ok: " + msg);
}

// Verify HEAD's commit signature: `git verify-commit HEAD` exits 0 on a
// Good signature -- the same truth signal a signed-commit ruleset checks.
function verifyCommitSignature() {
  const rv = capture("git", ["verify-commit", "HEAD"]);
  if (rv.status !== 0) {
    throw new Error("HEAD commit signature is not Good -- check SSH signing setup " +
      "(commit.gpgsign=true + gpg.format=ssh + allowed_signers populated)." +
      (rv.stderr ? "\n" + rv.stderr : ""));
  }
  const sig = capture("git", ["log", "-1", "--pretty=%h %G? %GS"]);
  console.log("signature: " + sig.stdout);
  ok("commit signature verified");
}

// ---- Subcommands ----------------------------------------------------------

function cmdStatus() {
  section("status");
  console.log("package version:  " + readVersion());
  console.log("branch:           " + gitBranch());
  console.log("clean:            " + gitClean());
  console.log("release-notes:    " +
    (readNotesPresent(readVersion()) ? "present" : "missing (release-notes/v" + readVersion() + ".json)"));
  let smokeLine = "(no run recorded -- npm run smoke)";
  try {
    const st = statSync(join(ROOT, ".test-output", "smoke.log"));
    smokeLine = st.mtime.toISOString() + " (.test-output/smoke.log)";
  } catch { /* never run */ }
  console.log("last smoke:       " + smokeLine);
  const remote = capture("git", ["remote"]).stdout;
  console.log("remote:           " + (remote || "(none -- " + REMOTE_ONLY.join("/") + " inactive)"));
  const tag = capture("git", ["tag", "-l", "v" + readVersion()]).stdout;
  console.log("tag v" + readVersion() + ":       " + (tag ? "exists" : "(not yet tagged)"));
}

function readNotesPresent(version) {
  try {
    readFileSync(releaseNotesPath(version), "utf8");
    return true;
  } catch {
    return false;
  }
}

function cmdRegen() {
  section("regen");
  run("node", ["scripts/regen-changelog.js"]);
  run("node", ["scripts/refresh-api-snapshot.js"]);
  ok("CHANGELOG.md + api-snapshot.json regenerated");
}

function cmdSmoke() {
  section("smoke");
  run("node", ["scripts/smoke.js"]);
  ok("smoke pipeline green");
}

function cmdCommit() {
  section("commit");
  const version = readVersion();
  const notes = readReleaseNotes(version);
  if (gitClean()) {
    throw new Error("nothing to commit -- the working tree is clean");
  }

  // The gates are the confirmation: a failing pipeline refuses the commit.
  run("node", ["scripts/smoke.js"]);
  ok("gates green");

  const lines = [version + " \u2014 " + notes.headline, "", notes.summary];
  const sections = notes.sections && typeof notes.sections === "object" ? notes.sections : {};
  for (const heading of Object.keys(sections)) {
    if (!Array.isArray(sections[heading]) || sections[heading].length === 0) continue;
    lines.push("", heading + ":");
    for (const item of sections[heading]) lines.push("  - " + item);
  }

  run("git", ["add", "-A"]);
  run("git", ["commit", "-F", "-"], { input: lines.join("\n") + "\n" });
  ok("signed commit created");
  verifyCommitSignature();
}

function cmdTag() {
  section("tag");
  if (!gitClean()) {
    throw new Error("tag requires a clean working tree");
  }
  const version = readVersion();
  const tag = "v" + version;
  if (capture("git", ["tag", "-l", tag]).stdout === tag) {
    throw new Error("tag " + tag + " already exists -- this version is already tagged");
  }
  run("git", ["tag", "-s", tag, "-m", tag]);

  // Verify the signature immediately; a bad signature deletes the tag so a
  // re-run after fixing the signing setup starts clean.
  const verify = capture("git", ["tag", "-v", tag]);
  if (verify.stderr.indexOf("Good") === -1 && verify.stdout.indexOf("Good") === -1) {
    run("git", ["tag", "-d", tag], { allowFail: true });
    throw new Error("`git tag -v " + tag + "` did not report a Good signature -- " +
      "check SSH signing setup (tag.gpgsign=true + gpg.format=ssh + " +
      "allowed_signers populated). The local tag was removed.\n" +
      (verify.stderr || verify.stdout));
  }
  ok("annotated signed tag " + tag + " created (signature: Good)");
}

function requireRemote() {
  const remote = capture("git", ["remote", "get-url", "origin"]).stdout;
  if (!remote) {
    throw new Error("no origin remote configured (git remote add origin <url>)");
  }
  return remote;
}

// Synchronous sleep for the poll loops; the script is spawnSync-style
// throughout and a wait here blocks nothing else.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function currentBranch() {
  return capture("git", ["branch", "--show-current"]).stdout;
}

function ghJson(args) {
  const rv = capture("gh", args);
  if (!rv.stdout) throw new Error("gh " + args.join(" ") + " returned nothing");
  return JSON.parse(rv.stdout);
}

// ---- The review blocker -----------------------------------------------------
// Merging is gated on BOTH the required checks and a reviewer verdict for
// the PR's CURRENT head commit. The reviewer posts issue comments citing
// the head SHA; a verdict that names findings blocks the merge until a
// root fix lands via push-fix and a fresh verdict clears it. Overriding
// requires the explicit flag -- loudly.
const REVIEW_BOT_PATTERN = /codex/i;

function reviewVerdict(branch, headSha) {
  const comments = ghJson(["pr", "view", branch, "--json", "comments",
    "--jq", "[.comments[] | {author: .author.login, body: .body}]"]);
  const short = headSha.slice(0, 7);
  const fromBot = comments.filter(function (c) {
    return REVIEW_BOT_PATTERN.test(c.author || "") &&
      (c.body.indexOf(headSha) !== -1 || c.body.indexOf(short) !== -1);
  });
  if (fromBot.length === 0) return { state: "pending" };
  const latest = fromBot[fromBot.length - 1];
  if (/\bP[12]\b/.test(latest.body)) return { state: "findings", body: latest.body };
  return { state: "clean" };
}

function requestReview(branch) {
  run("gh", ["pr", "comment", branch, "--body", "@codex review"]);
}

// prepare [version] -- start a bump-only cut on a clean, synced main:
// bump package.json (default: next patch) on a fresh release branch.
function cmdPrepare() {
  section("prepare");
  requireRemote();
  if (currentBranch() !== "main") throw new Error("prepare starts from main");
  if (!gitClean()) throw new Error("prepare requires a clean working tree");
  run("git", ["pull", "--ff-only"]);
  const current = readVersion();
  let next = process.argv[3];
  if (!next) {
    const parts = current.split(".").map(Number);
    parts[2] += 1;
    next = parts.join(".");
  }
  if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error("bad version '" + next + "'");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  pkg.version = next;
  writeFileSync(join(ROOT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  run("git", ["checkout", "-b", "release-v" + next]);
  ok("version " + current + " -> " + next + " on branch release-v" + next);
  if (!readNotesPresent(next)) {
    console.log("next: write " + releaseNotesPath(next) + ", then regen -> commit -> push -> watch -> tag -> publish");
  }
}

// push -- publish the current branch, open its PR, and request review.
// No auto-merge: the merge belongs to watch, AFTER the review verdict.
function cmdPush() {
  section("push");
  requireRemote();
  const branch = currentBranch();
  if (!branch || branch === "main") throw new Error("push runs from a release/fix branch, not main");
  if (!gitClean()) throw new Error("push requires a committed tree (run: release.js commit)");
  const version = readVersion();
  run("git", ["push", "-u", "origin", branch]);
  const existing = capture("gh", ["pr", "view", branch, "--json", "state", "--jq", ".state"]).stdout;
  if (existing !== "OPEN") {
    // The notes title a RELEASE branch; any other branch titles from its commit.
    const isReleaseBranch = branch === "release-v" + version;
    const notes = isReleaseBranch && readNotesPresent(version) ? readReleaseNotes(version) : null;
    const title = notes ? version + " \u2014 " + notes.headline : capture("git", ["log", "-1", "--format=%s"]).stdout;
    const body = notes ? notes.summary : "See the commit message.";
    run("gh", ["pr", "create", "--title", title, "--body", body]);
  }
  requestReview(branch);
  ok("PR open, review requested -- next: release.js watch");
}

// push-fix -m "..." -- land a root fix for review findings as a NEW
// signed commit (never amend), push it, and re-request review.
function cmdPushFix() {
  section("push-fix");
  requireRemote();
  const branch = currentBranch();
  if (!branch || branch === "main") throw new Error("push-fix runs from the branch under review");
  const mFlag = process.argv.indexOf("-m");
  const message = mFlag !== -1 ? process.argv[mFlag + 1] : null;
  if (!message) throw new Error('push-fix requires -m "<root-cause fix message>"');
  if (gitClean()) throw new Error("nothing to commit -- push-fix expects the fix in the working tree");
  run("node", ["scripts/smoke.js"]);
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", message]);
  verifyCommitSignature();
  run("git", ["push"]);
  requestReview(branch);
  ok("fix pushed as a new signed commit; review re-requested -- next: release.js watch");
}

// watch -- follow the current branch's PR until required checks pass AND
// the review verdict is clean for the head commit, then squash-merge,
// sync main, and drop the branch. --no-review skips the verdict gate,
// loudly, for repos without the reviewer installed.
function cmdWatch() {
  section("watch");
  requireRemote();
  const branch = currentBranch();
  if (!branch || branch === "main") throw new Error("watch runs from the branch whose PR is in flight");
  const skipReview = process.argv.indexOf("--no-review") !== -1;
  if (skipReview) console.log("!! review gate SKIPPED by explicit --no-review");
  let reviewNudged = false;
  for (let i = 0; i < 90; i++) {
    const pr = ghJson(["pr", "view", branch, "--json", "state,headRefOid,statusCheckRollup"]);
    if (pr.state === "MERGED") break;
    if (pr.state !== "OPEN") throw new Error("PR is " + pr.state);
    const rollup = pr.statusCheckRollup || [];
    const failed = rollup.filter(function (c) {
      return String(c.conclusion || "").toUpperCase() === "FAILURE";
    });
    if (failed.length > 0) {
      throw new Error("checks failed: " + failed.map(function (c) { return c.name || c.context; }).join(", ") +
        " -- fix at the root, then release.js push-fix");
    }
    const pending = rollup.filter(function (c) {
      return !c.conclusion && String(c.status || "").toUpperCase() !== "COMPLETED" && !c.state;
    });
    const checksDone = pending.length === 0 && rollup.length > 0;
    let reviewDone = skipReview;
    if (!skipReview) {
      const verdict = reviewVerdict(branch, pr.headRefOid);
      if (verdict.state === "findings") {
        throw new Error("review findings block the merge -- fix each at the root (new commit, never amend) via release.js push-fix, which re-requests review");
      }
      reviewDone = verdict.state === "clean";
      if (!reviewDone && checksDone && i >= 15 && !reviewNudged) {
        // checks long green, no verdict: nudge once, then keep waiting --
        // an absent reviewer is a loud failure at the timeout, never a
        // silent pass.
        requestReview(branch);
        reviewNudged = true;
      }
    }
    if (checksDone && reviewDone) {
      run("gh", ["pr", "merge", branch, "--squash"]);
      break;
    }
    console.log("  checks " + (checksDone ? "green" : "running") + ", review " +
      (skipReview ? "skipped" : (reviewDone ? "clean" : "pending")) + " (" + (i + 1) + ")...");
    sleep(20000);
    if (i === 89) throw new Error("watch timed out -- if no reviewer is installed on this repo, rerun with --no-review (explicit, logged)");
  }
  run("git", ["checkout", "main"]);
  run("git", ["pull", "--ff-only"]);
  run("git", ["branch", "-D", branch]);
  ok("merged; main synced; branch " + branch + " removed");
}

// merge -- alias for watch (the merge lives inside the gated loop).
function cmdMerge() {
  cmdWatch();
}

// publish -- push the version's signed tag (idempotent) and follow the
// tag-triggered publish run to completion, then confirm the registry
// serves the version.
function cmdPublish() {
  section("publish");
  requireRemote();
  const version = readVersion();
  const tag = "v" + version;
  if (capture("git", ["tag", "-l", tag]).stdout !== tag) {
    throw new Error("no local tag " + tag + " -- run: release.js tag");
  }
  const onRemote = capture("git", ["ls-remote", "origin", "refs/tags/" + tag]).stdout;
  if (!onRemote) run("git", ["push", "origin", tag]);
  const tagSha = capture("git", ["rev-parse", tag + "^{commit}"]).stdout;
  let runId = null;
  for (let i = 0; i < 60; i++) {
    if (runId === null) {
      const runs = ghJson(["run", "list", "--workflow", "npm-publish.yml", "--limit", "5",
        "--json", "databaseId,headSha,status,conclusion,event"]);
      const match = runs.find(function (r) { return r.headSha === tagSha && r.event === "push"; });
      if (match) runId = match.databaseId;
    }
    if (runId !== null) {
      const st = ghJson(["run", "view", String(runId), "--json", "status,conclusion"]);
      if (st.status === "completed") {
        if (st.conclusion !== "success") {
          throw new Error("publish run " + runId + " concluded " + st.conclusion + " -- read its log, fix at the root, cut the next patch");
        }
        break;
      }
    }
    console.log("  publish run " + (runId === null ? "not visible yet" : runId + " in progress") + " (" + (i + 1) + ")...");
    sleep(20000);
    if (i === 59) throw new Error("publish watch timed out");
  }
  const served = capture("npm", ["view", "@blamejs/stash@" + version, "version"]).stdout;
  if (served !== version) {
    throw new Error("registry serves '" + served + "' for " + version + " -- verify manually before trusting the release");
  }
  ok("published: @blamejs/stash@" + version + " live on the registry, GitHub release created");
}

function cmdHelp() {
  console.log("release.js -- orchestrated release flow (no confirmation prompts; the gates are the confirmation)");
  console.log("");
  console.log("Usage:");
  console.log("  node scripts/release.js status    # version, branch, cleanliness, gate freshness");
  console.log("  node scripts/release.js regen     # regen CHANGELOG.md + api-snapshot.json");
  console.log("  node scripts/release.js smoke     # full smoke pipeline (scripts/smoke.js)");
  console.log("  node scripts/release.js commit    # gates -> git add -A -> signed commit from release-notes JSON");
  console.log("  node scripts/release.js tag       # annotated signed tag v<version> (clean tree, untagged version)");
  console.log("  node scripts/release.js help      # this banner");
  console.log("");
  console.log("  prepare [ver]  # clean main -> bump (default next patch) -> release branch");
  console.log("  push           # push branch, open PR from the notes, request review");
  console.log("  push-fix -m .. # root fix for review findings: new signed commit, push, re-request");
  console.log("  watch          # gate on checks AND the review verdict, then squash-merge + sync");
  console.log("  merge          # alias for watch");
  console.log("  publish        # push the signed tag, follow the publish run, verify the registry");
  console.log("");
  console.log("`commit` requires release-notes/v<version>.json (headline + summary +");
  console.log("sections); it prints a stub template and refuses when the file is missing.");
}

// ---- Dispatch ---------------------------------------------------------------

const sub = process.argv[2] || "help";

try {
  {
    switch (sub) {
      case "prepare": cmdPrepare(); break;
      case "push": cmdPush(); break;
      case "push-fix": cmdPushFix(); break;
      case "watch": cmdWatch(); break;
      case "merge": cmdMerge(); break;
      case "publish": cmdPublish(); break;
      case "status": cmdStatus(); break;
      case "regen": cmdRegen(); break;
      case "smoke": cmdSmoke(); break;
      case "commit": cmdCommit(); break;
      case "tag": cmdTag(); break;
      case "help":
      case "--help":
      case "-h": cmdHelp(); break;
      default:
        console.error("release: unknown subcommand '" + sub + "'");
        cmdHelp();
        process.exit(1);
    }
  }
} catch (e) {
  console.error("\nrelease: FAIL -- " + ((e && e.message) || e));
  process.exit(1);
}
