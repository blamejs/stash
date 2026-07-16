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
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REMOTE_ONLY = ["prepare", "push", "watch", "merge", "publish"];

function run(cmd, args, opts) {
  const rv = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: (opts && opts.stdio) || "inherit",
    input: opts && opts.input,
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

function cmdRemoteOnly(name) {
  console.error("release: `" + name + "` is remote-dependent and inactive -- it activates when a GitHub remote is configured (git remote add origin <url>).");
  process.exit(1);
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
  console.log("Remote-dependent (inactive until a GitHub remote is configured):");
  console.log("  prepare / push / watch / merge / publish");
  console.log("");
  console.log("`commit` requires release-notes/v<version>.json (headline + summary +");
  console.log("sections); it prints a stub template and refuses when the file is missing.");
}

// ---- Dispatch ---------------------------------------------------------------

const sub = process.argv[2] || "help";

try {
  if (REMOTE_ONLY.indexOf(sub) !== -1) {
    cmdRemoteOnly(sub);
  } else {
    switch (sub) {
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
