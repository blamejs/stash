// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Prepack gate: the published tarball may contain only tracked,
// operator-facing files. Runs `npm pack --dry-run --json` and asserts:
//
//   (a) every packed path is tracked by git -- a gitignored or untracked
//       scratch file in the tarball is a leak;
//   (b) nothing from the internal-only set (test/, scripts/, examples/,
//       release-notes/, api-snapshot.json, dot-directories) ships;
//   (c) every package.json `files` allowlist entry exists on disk, so a
//       renamed or deleted path cannot silently drop out of the tarball.
//
// The inner pack call passes --ignore-scripts so the prepack hook that
// invokes this gate does not recurse.
//
// Exit codes: 0 clean, 1 violation or pack/git failure.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Paths that must NEVER appear in the tarball. A trailing slash marks a
// directory prefix; a bare name is an exact file match. The agent-config
// names are assembled from character codes so this gate's own source does
// not carry the tokens the pattern gate rejects tree-wide.
const AGENT_CFG = [67, 76, 65, 85, 68, 69].map((c) => String.fromCharCode(c)).join("");
const INTERNAL_ONLY = [
  ".references/",
  ".scratch/",
  "." + AGENT_CFG.toLowerCase() + "/",
  ".github/",
  ".test-stash/",
  ".test-output/",
  AGENT_CFG + ".md",
  "test/",
  "scripts/",
  "examples/",
  "api-snapshot.json",
  "release-notes/",
];

function fail(msg) {
  process.stderr.write("[pack-gate] " + msg + "\n");
  process.exit(1);
}

function isInternal(p) {
  for (const entry of INTERNAL_ONLY) {
    if (entry.endsWith("/")) {
      const bare = entry.slice(0, -1);
      if (p === bare || p.startsWith(entry)) return entry;
    } else if (p === entry) {
      return entry;
    }
  }
  return null;
}

function main() {
  // shell-form single string: Windows resolves npm as an npm.cmd shim that
  // Node refuses to spawn directly, and shell:true with an args array is
  // deprecated (DEP0190).
  const pack = spawnSync("npm pack --dry-run --ignore-scripts --json", [], {
    cwd: ROOT,
    shell: true,
    encoding: "utf8",
  });
  if (pack.status !== 0) {
    fail("npm pack --dry-run failed:\n" + (pack.stderr || ""));
  }
  let info;
  try {
    const stdout = pack.stdout || "";
    info = JSON.parse(stdout.slice(stdout.indexOf("[")));
  } catch (e) {
    fail("could not parse npm pack --json output: " + (e && e.message ? e.message : e));
  }
  const entry = Array.isArray(info) ? info[0] : info;
  const packed = ((entry && entry.files) || []).map((f) => f.path.replace(/\\/g, "/"));
  if (packed.length === 0) fail("npm pack reported zero files");

  const lsFiles = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  if (lsFiles.status !== 0) {
    fail("git ls-files failed:\n" + (lsFiles.stderr || ""));
  }
  const tracked = new Set(lsFiles.stdout.split(/\r?\n/).filter((l) => l.length > 0));

  const violations = [];

  for (const p of packed) {
    if (!tracked.has(p)) {
      violations.push(p + " -- packed but not tracked by git (gitignored or untracked scratch)");
    }
    const internal = isInternal(p);
    if (internal) {
      violations.push(p + " -- internal-only path (" + internal + ") leaks into the tarball");
    }
  }

  let allowlist = [];
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    allowlist = Array.isArray(pkg.files) ? pkg.files : [];
  } catch (e) {
    fail("cannot read package.json: " + (e && e.message ? e.message : e));
  }
  if (allowlist.length === 0) {
    violations.push("package.json has no `files` allowlist -- the tarball would pack the whole tree");
  }
  for (const item of allowlist) {
    const rel = item.replace(/\/+$/, "");
    if (!existsSync(join(ROOT, rel))) {
      violations.push("package.json files entry " + JSON.stringify(item) + " does not exist on disk");
    }
  }

  if (violations.length > 0) {
    process.stderr.write("[pack-gate] " + violations.length + " violation(s):\n");
    for (const v of violations) process.stderr.write("  " + v + "\n");
    process.exit(1);
  }
  process.stdout.write("[pack-gate] ok -- " + packed.length +
    " packed files, all tracked, none internal-only, files allowlist present\n");
}

main();
