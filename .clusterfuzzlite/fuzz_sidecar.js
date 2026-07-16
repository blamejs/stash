// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Fuzz target: the disk backend's sidecar read path on arbitrary bytes.
//
// The sidecar (meta/<id>.json) is the one place the store parses bytes it
// did not just compute -- a crashed writer, store tampering, and bit rot
// all land here (SPEC.md 9). The target plants the fuzzer's bytes as the
// sidecar for a pinned ref, then drives the shipped consumer path:
// stash.show (bounded read -> JSON.parse -> canonical shape validation ->
// identity check) and, when the shape passes, stash.apply (the
// digest-verified read stream) over a planted blob.
//
// Every rejection must be a typed StashError (EINTEGRITY / ENOREF);
// hostile bytes may also happen to describe a fully coherent entry, in
// which case both verbs must succeed. Anything else escaping -- a
// TypeError, a RangeError, a hang -- is a real finding.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiskBackend } from "../src/backends/disk.js";
import { StashError } from "../src/errors.js";
import { Stash } from "../src/stash.js";

// The pinned ref every hostile sidecar claims to describe. The blob
// planted under it holds BLOB_BYTES, so a shape-valid sidecar carrying
// that content's sha256 drives the digest-verified stream to success and
// any other digest to EINTEGRITY.
export const REF = "v1_" + "A".repeat(43);
export const BLOB_BYTES = "hello";
export const ROOT = mkdtempSync(join(tmpdir(), "stash-fuzz-sidecar-"));

const stash = new Stash({ backend: new DiskBackend({ root: ROOT }) });
const sidecarPath = join(ROOT, "meta", REF + ".json");

let layout = null;
function ready() {
  if (layout === null) {
    // The first list() materializes the backend's directory layout; the
    // blob is planted directly because the fuzzer, not push, owns the
    // sidecar under test.
    layout = stash.list().then(() => {
      writeFileSync(join(ROOT, "blobs", REF), BLOB_BYTES);
    });
  }
  return layout;
}

// fuzz(data) -> verdict string: "accepted" (both verbs succeeded),
// "<code>" (show refused the sidecar), or "shown:<code>" (the shape
// passed but the verified read refused). local-smoke.js asserts on the
// verdict.
export async function fuzz(data) {
  await ready();
  writeFileSync(sidecarPath, data);
  try {
    await stash.show(REF);
  } catch (err) {
    if (err instanceof StashError) return err.code;
    throw err;
  }
  try {
    const readable = await stash.apply(REF);
    for await (const chunk of readable) void chunk;
  } catch (err) {
    if (err instanceof StashError) return "shown:" + err.code;
    throw err;
  }
  return "accepted";
}
