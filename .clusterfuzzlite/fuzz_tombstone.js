// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Fuzz target: the disk backend's tombstone-grave read path on arbitrary
// bytes.
//
// A grave (tombstones/<id>.json) is the second place the store parses bytes
// it did not just compute -- a crashed writer, store tampering, and bit rot
// all land here exactly as they do on the entry sidecar (SPEC.md 9, 4.4).
// The target plants the fuzzer's bytes as the grave for a pinned ref, then
// drives the shipped consumer path: stash.tombstones() (bounded read ->
// JSON.parse -> exact-shape validation -> id identity check).
//
// Every rejection must be a typed StashError (EINTEGRITY); hostile bytes may
// also happen to describe a fully coherent grave, in which case tombstones()
// must list it. Anything else escaping -- a TypeError, a RangeError, a hang
// -- is a real finding.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiskBackend } from "../src/backends/disk.js";
import { StashError } from "../src/errors.js";
import { Stash } from "../src/stash.js";

// The pinned ref every hostile grave claims to describe. A grave whose
// parsed id matches drives the identity check to success; any other id is
// EINTEGRITY.
export const REF = "v1_" + "A".repeat(43);
export const ROOT = mkdtempSync(join(tmpdir(), "stash-fuzz-tombstone-"));

const stash = new Stash({ backend: new DiskBackend({ root: ROOT }) });
const gravePath = join(ROOT, "tombstones", REF + ".json");

let layout = null;
function ready() {
  if (layout === null) {
    // The first tombstones() materializes the backend's tombstones/ layout;
    // the grave is planted directly because the fuzzer, not a destruction,
    // owns the bytes under test.
    layout = stash.tombstones();
  }
  return layout;
}

// fuzz(data) -> verdict string: "listed" (the grave parsed clean and its id
// matched, so tombstones() returned it) or "<code>" (tombstones() refused the
// grave). local-smoke.js asserts on the verdict.
export async function fuzz(data) {
  await ready();
  writeFileSync(gravePath, data);
  try {
    await stash.tombstones();
  } catch (err) {
    if (err instanceof StashError) return err.code;
    throw err;
  }
  return "listed";
}
