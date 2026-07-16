// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Gate: diff the live public surface against api-snapshot.json.
//
// Removed member / kind change / arity change / array shrink -> BREAKING,
// exit 1. Added member -> additive, logged, exit 0 (refresh the snapshot in
// the same commit). A shipped primitive's @since is immutable. Exit 2 on a
// missing baseline or script error.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { capture, assertSinceImmutable } from "./refresh-api-snapshot.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = join(ROOT, "api-snapshot.json");

function compare(baseline, current, path, breaking, additive) {
  if (baseline.kind !== current.kind) {
    breaking.push(path + ": kind changed " + baseline.kind + " -> " + current.kind);
    return;
  }
  if ("arity" in baseline && baseline.arity !== current.arity) {
    breaking.push(path + ": arity changed " + baseline.arity + " -> " + current.arity);
  }
  if ("length" in baseline && current.length < baseline.length) {
    breaking.push(path + ": array shrank " + baseline.length + " -> " + current.length);
  }
  for (const nested of ["members", "methods"]) {
    if (!(nested in baseline) && !(nested in current)) continue;
    const base = baseline[nested] || {};
    const curr = current[nested] || {};
    for (const key of Object.keys(base)) {
      if (!(key in curr)) breaking.push(path + "." + key + ": removed");
      else compare(base[key], curr[key], path + "." + key, breaking, additive);
    }
    for (const key of Object.keys(curr)) {
      if (!(key in base)) additive.push(path + "." + key + ": added (" + curr[key].kind + ")");
    }
  }
}

async function main() {
  if (!existsSync(SNAPSHOT_PATH)) {
    console.error("api-snapshot.json is missing; run: node scripts/refresh-api-snapshot.js");
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const current = await capture();

  const breaking = [];
  const additive = [];
  for (const entry of Object.keys(baseline.surface)) {
    if (!(entry in current.surface)) {
      breaking.push(entry + ": entry point removed");
      continue;
    }
    compare(baseline.surface[entry], current.surface[entry], entry, breaking, additive);
  }
  for (const entry of Object.keys(current.surface)) {
    if (!(entry in baseline.surface)) additive.push(entry + ": entry point added");
  }

  try {
    assertSinceImmutable(baseline, current);
  } catch (err) {
    breaking.push(err.message);
  }

  for (const line of additive) console.log("additive: " + line);
  if (breaking.length > 0) {
    for (const line of breaking) console.error("BREAKING: " + line);
    console.error("api surface diverges from api-snapshot.json (" + breaking.length + " breaking)");
    process.exit(1);
  }
  console.log("api snapshot: surface matches (" +
    Object.keys(baseline.sinceByPrimitive).length + " primitives" +
    (additive.length > 0 ? ", " + additive.length + " additive -- refresh the snapshot" : "") + ")");
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(2);
});
