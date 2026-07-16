// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Gate: diff the live public surface against api-snapshot.json.
//
// The snapshot must match the live surface EXACTLY -- the check fails on
// any divergence a refresh-api-snapshot.js run would rewrite, so the gate
// can never pass while the snapshot is stale. A member that lands without
// being snapshotted has no removal or arity protection until the refresh
// happens; requiring the refresh in the same change closes that window.
// Two verdict classes, both exit 1:
//
//   BREAKING -- removed member / kind change / arity change / array
//               shrink / @since rewrite: shipped surface was reshaped.
//   STALE    -- added member or entry point, an added or removed
//               @primitive block, a package version bump: run
//               `node scripts/refresh-api-snapshot.js` and commit the
//               refreshed snapshot alongside the change.
//
// Exit 2 on a missing baseline or script error.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { capture, assertSinceImmutable } from "./refresh-api-snapshot.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = join(ROOT, "api-snapshot.json");

function compare(baseline, current, path, breaking, stale) {
  if (baseline.kind !== current.kind) {
    breaking.push(path + ": kind changed " + baseline.kind + " -> " + current.kind);
    return;
  }
  if ("arity" in baseline && baseline.arity !== current.arity) {
    breaking.push(path + ": arity changed " + baseline.arity + " -> " + current.arity);
  }
  if ("length" in baseline && current.length < baseline.length) {
    breaking.push(path + ": array shrank " + baseline.length + " -> " + current.length);
  } else if ("length" in baseline && current.length > baseline.length) {
    // Growth is not breaking, but the added members are not in the snapshot
    // -- a refresh would rewrite it, so the check must not pass silently.
    stale.push(path + ": array grew " + baseline.length + " -> " + current.length + " but not snapshotted");
  }
  for (const nested of ["members", "methods"]) {
    if (!(nested in baseline) && !(nested in current)) continue;
    const base = baseline[nested] || {};
    const curr = current[nested] || {};
    for (const key of Object.keys(base)) {
      if (!(key in curr)) breaking.push(path + "." + key + ": removed");
      else compare(base[key], curr[key], path + "." + key, breaking, stale);
    }
    for (const key of Object.keys(curr)) {
      if (!(key in base)) stale.push(path + "." + key + ": added (" + curr[key].kind + ") but not snapshotted");
    }
  }
}

// diffSnapshot(baseline, current, packageVersion) -> { breaking, stale }.
// The gate is clean ONLY when both lists are empty: any non-empty list is
// a divergence between the snapshot and what a refresh would write.
export function diffSnapshot(baseline, current, packageVersion) {
  const breaking = [];
  const stale = [];

  for (const entry of Object.keys(baseline.surface)) {
    if (!(entry in current.surface)) {
      breaking.push(entry + ": entry point removed");
      continue;
    }
    compare(baseline.surface[entry], current.surface[entry], entry, breaking, stale);
  }
  for (const entry of Object.keys(current.surface)) {
    if (!(entry in baseline.surface)) stale.push(entry + ": entry point added but not snapshotted");
  }

  const baseSince = baseline.sinceByPrimitive || {};
  const currSince = current.sinceByPrimitive || {};
  for (const token of Object.keys(baseSince)) {
    if (!(token in currSince)) {
      stale.push(token + ": @primitive block no longer found in src/ (removed or untagged) -- the snapshot still carries it");
    }
  }
  for (const token of Object.keys(currSince)) {
    if (!(token in baseSince)) stale.push(token + ": @primitive block not in the snapshot");
  }

  try {
    assertSinceImmutable(baseline, current);
  } catch (err) {
    breaking.push(err.message);
  }

  if (packageVersion !== undefined && baseline.packageVersion !== packageVersion) {
    stale.push("snapshot was generated at package version " + baseline.packageVersion +
      " but package.json is " + packageVersion);
  }

  return { breaking, stale };
}

// isClean(diff) -> the boolean verdict the CLI exits on.
export function isClean(diff) {
  return diff.breaking.length === 0 && diff.stale.length === 0;
}

async function main() {
  if (!existsSync(SNAPSHOT_PATH)) {
    console.error("api-snapshot.json is missing; run: node scripts/refresh-api-snapshot.js");
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const current = await capture();

  const diff = diffSnapshot(baseline, current, pkg.version);
  for (const line of diff.breaking) console.error("BREAKING: " + line);
  for (const line of diff.stale) console.error("STALE: " + line);
  if (!isClean(diff)) {
    console.error("api surface diverges from api-snapshot.json (" +
      diff.breaking.length + " breaking, " + diff.stale.length + " stale)");
    if (diff.stale.length > 0) {
      console.error("stale entries: run `node scripts/refresh-api-snapshot.js` and commit the refreshed snapshot");
    }
    process.exit(1);
  }
  console.log("api snapshot: surface matches (" +
    Object.keys(baseline.sinceByPrimitive).length + " primitives)");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(2);
  });
}
