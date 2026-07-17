// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Local proof that the fuzz targets load and discriminate, with plain
// node and zero dependencies: every committed seed is fed through the
// same fuzz() entry points the fuzzing engine drives, and the verdict
// each target returns is asserted against the tables below; a battery of
// generated hostile inputs then checks the boundary verdicts. Run it
// after any change to the targets, the seeds, or the surfaces they
// exercise:
//
//   node .clusterfuzzlite/local-smoke.js
//
// Exit 0: every input produced its expected verdict. Exit 1: a verdict
// diverged or a non-StashError escaped a target -- the same signal the
// fuzzer reports as a crash.

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { C } from "../src/constants.js";
import { fuzz as fuzzRef } from "./fuzz_ref.js";
import { fuzz as fuzzSidecar, ROOT as SIDECAR_ROOT } from "./fuzz_sidecar.js";
import { fuzz as fuzzTombstone, ROOT as TOMBSTONE_ROOT } from "./fuzz_tombstone.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// seed filename -> the exact verdict its target must return. Every seed
// on disk must have a row here, and every row a seed -- an uncatalogued
// seed would run without an assertion and prove nothing.
const EXPECTED = {
  fuzz_ref: {
    "valid-shape.txt": "ENOREF",
    "traversal.txt": "EBADREF",
    "traversal-in-shape.txt": "EBADREF",
    "empty.txt": "EBADREF",
    "long.txt": "EBADREF",
    "short-by-one.txt": "EBADREF",
    "case-prefix.txt": "EBADREF",
    "b64-standard-alphabet.txt": "EBADREF",
    "nul-byte.txt": "EBADREF",
    "unicode.txt": "EBADREF",
  },
  fuzz_sidecar: {
    "valid.json": "accepted",
    "bad-digest.json": "shown:EINTEGRITY",
    "truncated.json": "EINTEGRITY",
    "null.json": "EINTEGRITY",
    "nested.json": "EINTEGRITY",
    "wrong-id.json": "EINTEGRITY",
    "extra-field.json": "EINTEGRITY",
    "missing-field.json": "EINTEGRITY",
    "type-drift.json": "EINTEGRITY",
    "negative-size.json": "EINTEGRITY",
    "budget-incoherent.json": "EINTEGRITY",
    "proto-field.json": "EINTEGRITY",
    "huge-field.json": "EINTEGRITY",
  },
  fuzz_tombstone: {
    "valid.json": "listed",
    "truncated.json": "EINTEGRITY",
    "null.json": "EINTEGRITY",
    "nested.json": "EINTEGRITY",
    "wrong-id.json": "EINTEGRITY",
    "extra-field.json": "EINTEGRITY",
    "missing-field.json": "EINTEGRITY",
    "type-drift.json": "EINTEGRITY",
    "negative-destroyedAt.json": "EINTEGRITY",
    "bad-cause.json": "EINTEGRITY",
    "traversal-id.json": "EINTEGRITY",
    "proto-field.json": "EINTEGRITY",
    "huge-field.json": "EINTEGRITY",
  },
};

let failures = 0;
let checks = 0;

function check(label, got, want) {
  checks += 1;
  if (got === want) return;
  failures += 1;
  console.error("FAIL  " + label + ": expected " + JSON.stringify(want) + ", got " + JSON.stringify(got));
}

async function verdictOf(fuzzFn, label, bytes) {
  try {
    return await fuzzFn(bytes);
  } catch (err) {
    failures += 1;
    checks += 1;
    console.error("FAIL  " + label + ": escaped with " + (err && err.name) + ": " + (err && err.message));
    return null;
  }
}

async function runSeeds(targetName, fuzzFn) {
  const dir = join(HERE, "seeds", targetName);
  const table = EXPECTED[targetName];
  const onDisk = readdirSync(dir).sort();
  for (const name of Object.keys(table)) {
    if (!onDisk.includes(name)) {
      failures += 1;
      checks += 1;
      console.error("FAIL  " + targetName + "/" + name + ": cataloged seed missing on disk");
    }
  }
  for (const name of onDisk) {
    const label = targetName + "/" + name;
    const want = table[name];
    if (want === undefined) {
      failures += 1;
      checks += 1;
      console.error("FAIL  " + label + ": seed has no expected-verdict row");
      continue;
    }
    const got = await verdictOf(fuzzFn, label, readFileSync(join(dir, name)));
    if (got !== null) check(label, got, want);
  }
}

// Deterministic pseudo-random bytes (LCG), so a failure reproduces.
function prngBytes(length, seed) {
  const out = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

async function runGenerated() {
  // Any 4 KiB of noise decodes to a string far off the whitelist.
  check(
    "fuzz_ref/<generated 4KiB noise>",
    await verdictOf(fuzzRef, "fuzz_ref/<generated 4KiB noise>", prngBytes(4096, 1)),
    "EBADREF",
  );
  // Noise is not JSON.
  check(
    "fuzz_sidecar/<generated 256B noise>",
    await verdictOf(fuzzSidecar, "fuzz_sidecar/<generated 256B noise>", prngBytes(256, 2)),
    "EINTEGRITY",
  );
  // One byte over the 64 KiB sidecar bound: refused unread regardless of
  // content.
  check(
    "fuzz_sidecar/<generated 64KiB+1>",
    await verdictOf(fuzzSidecar, "fuzz_sidecar/<generated 64KiB+1>", Buffer.alloc(64 * C.BYTES.KIB + 1, 0x7b)),
    "EINTEGRITY",
  );
  // A grave of noise is not JSON.
  check(
    "fuzz_tombstone/<generated 256B noise>",
    await verdictOf(fuzzTombstone, "fuzz_tombstone/<generated 256B noise>", prngBytes(256, 3)),
    "EINTEGRITY",
  );
  // One byte over the 1 KiB grave bound: refused unread regardless of content.
  check(
    "fuzz_tombstone/<generated 1KiB+1>",
    await verdictOf(fuzzTombstone, "fuzz_tombstone/<generated 1KiB+1>", Buffer.alloc(C.BYTES.KIB + 1, 0x7b)),
    "EINTEGRITY",
  );
}

async function main() {
  await runSeeds("fuzz_ref", fuzzRef);
  await runSeeds("fuzz_sidecar", fuzzSidecar);
  await runSeeds("fuzz_tombstone", fuzzTombstone);
  await runGenerated();
  rmSync(SIDECAR_ROOT, { recursive: true, force: true });
  rmSync(TOMBSTONE_ROOT, { recursive: true, force: true });
  if (failures > 0) {
    console.error("fuzz-target smoke: " + failures + " of " + checks + " checks failed");
    process.exit(1);
  }
  console.log("fuzz-target smoke: " + checks + " checks ok (all targets load and discriminate)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
