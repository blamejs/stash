// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// check-lockfile-sync -- package-lock.json agrees with package.json, and still
// records zero dependencies.
//
// A version bump edits package.json; the lockfile records the same version in two
// places and does not follow on its own. A desynced lockfile is invisible to every
// other gate here -- the suite, the pattern detectors, and the pack gate all pass --
// and surfaces only as a failed publish or a CI lockfile check, after the release
// commit is already written. This runs with the cheap static gates so the version
// bump and its lockfile land in the same change.
//
// `engines.node` is mirrored the same way and drifts the same way, so it is
// compared too: raising the Node floor edits package.json only, and the two
// files then disagree until an unrelated install rewrites the lockfile.
//
// It also pins the zero-dependency posture (SPEC.md 2): the lockfile is the file a
// dependency would first appear in, so a package added by an editor's auto-install
// or a stray `npm i` is caught here rather than in a published tarball.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function checkLockfile(pkg, lock) {
  const problems = [];
  const root = (lock.packages || {})[""] || {};

  if (lock.name !== pkg.name || root.name !== pkg.name) {
    problems.push(
      `package-lock.json name (${lock.name} / ${root.name}) does not match package.json (${pkg.name})`,
    );
  }
  if (lock.version !== pkg.version || root.version !== pkg.version) {
    problems.push(
      `package-lock.json version (${lock.version} / ${root.version}) does not match package.json (${pkg.version})`,
    );
  }

  // The lockfile mirrors `engines`, and npm rewrites it from package.json on
  // the next install. Raising the Node floor touches package.json alone, so
  // the two drift apart in the release commit and agree again only once an
  // unrelated install rewrites the lockfile. Nothing else reads the field:
  // the suite, the pattern detectors, the pack gate and `npm ci --dry-run`
  // all pass with the two disagreeing.
  const pkgEngines = (pkg.engines || {}).node;
  const lockEngines = (root.engines || {}).node;
  if (pkgEngines !== lockEngines) {
    problems.push(
      `package-lock.json engines.node (${lockEngines}) does not match package.json (${pkgEngines})`,
    );
  }

  // Zero dependencies, runtime AND dev: the lockfile must describe this package only.
  const entries = Object.keys(lock.packages || {});
  const extra = entries.filter((k) => k !== "");
  if (extra.length > 0) {
    problems.push(
      `package-lock.json records ${extra.length} dependency entr(ies): ${extra.join(", ")}`,
    );
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const [source, where] of [
      [pkg, "package.json"],
      [root, "package-lock.json root"],
    ]) {
      const names = Object.keys(source[field] || {});
      if (names.length > 0) problems.push(`${where} declares ${field}: ${names.join(", ")}`);
    }
  }

  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = (name) => JSON.parse(readFileSync(join(ROOT, name), "utf8"));
  const pkg = read("package.json");
  const lock = read("package-lock.json");
  const problems = checkLockfile(pkg, lock);

  if (problems.length > 0) {
    for (const p of problems) console.error(`[lockfile-sync] ${p}`);
    console.error("[lockfile-sync] regenerate with: npm install --package-lock-only");
    process.exit(1);
  }

  console.log(
    `[lockfile-sync] ok -- ${pkg.name}@${pkg.version}, node ${(pkg.engines || {}).node}, zero dependencies`,
  );
}
