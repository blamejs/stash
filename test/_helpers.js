// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Shared test helpers -- the backend conformance factories, stream/entry
// fixtures, and the poll/retry primitives, in one home so the conformance suite,
// the disk suite, the model and chaos suites, and the CLI suite all compose the
// SAME fixtures rather than re-rolling them. A helper needed by a
// second test file moves here; nothing below constructs a mock a suite could not
// reuse. Not a test file itself (no `test(...)`), so `node --test` does not run it.

import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { RefClaimed } from "../src/index.js";
import { MemoryBackend } from "../src/backends/memory.js";
import { DiskBackend } from "../src/backends/disk.js";
import { freshScratchDir } from "./_scratch.js";

// The sandbox denies spawn; a vector that needs a child process (a process-exit
// recovery test, the CLI suite) skips there -- its scaffolding, not the library,
// needs the capability. The library itself is what must pass sandboxed.
export const SANDBOXED = typeof process.permission !== "undefined";

// pollUntil(fn) -- resolve once fn() is truthy, reject on timeout. Poll a
// condition for an event, never sleep a fixed span. (A fixed passive window
// appears only to prove the ABSENCE of an event.)
export async function pollUntil(fn, { timeout = 3000, step = 5 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error("pollUntil timed out");
    await new Promise((r) => setTimeout(r, step));
  }
}

// The backend factories every cross-backend case runs against, unmodified -- the
// parity axis. A new backend joins the whole suite by adding a factory here.
export const BACKENDS = [
  { name: "memory", create: () => new MemoryBackend() },
  { name: "disk", create: () => new DiskBackend({ root: freshScratchDir("conf") }) },
];

export async function drain(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// makeStoredEntry(id, bytes, overrides) -- a complete, self-consistent replicated
// Entry (the shape store() validates): size and digest computed over `bytes` so a
// clean store lands, with per-test overrides for the reconciliation/hostile cases.
export function makeStoredEntry(id, bytes, overrides = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    id,
    size: buf.length,
    digest: "sha256:" + createHash("sha256").update(buf).digest("hex"),
    createdAt: 1000,
    expiresAt: null,
    reads: null,
    readsLeft: null,
    meta: {},
    ...overrides,
  };
}

// syncOnce(from, to, bytesOf) -- one direction of a full-scan anti-entropy pass,
// ~drop-graves-then-store-live, no transport (the topology belongs to the consumer,
// SPEC.md 3). The source read is reconcilable(), not list(): list() is loud over a
// corrupt sidecar (right for an audit, wrong for replicating every HEALTHY entry), so
// one damaged entry would halt the whole sync; reconcilable() yields the healthy
// entries and reports the corrupt ids separately. `bytesOf(id)` yields the payload a
// live entry replicates (the harness cannot re-read a budgeted entry via apply --
// that would spend a credit -- so the caller supplies the bytes it pushed). Graves
// first so a store can never re-file an id the other side buried.
export async function syncOnce(from, to, bytesOf) {
  for (const grave of await from.tombstones()) await to.drop(grave.id);
  const { entries } = await from.reconcilable();
  for (const entry of entries) await to.store(entry, bytesOf(entry.id));
}

// The full backend method set. A probe/corrupting mock wraps a real backend and
// must implement all of it, or the Stash constructor rejects it (or #recover's
// listClaims call throws); this array keeps every mock in step with
// REQUIRED_BACKEND_METHODS as the contract grows across milestones.
export const BACKEND_METHODS = [
  "write", "read", "remove", "stat", "list", "listReconcilable", "stats", "verify",
  "claim", "restore", "commit", "listClaims", "consumeRead", "isClaimed",
  "writeTombstone", "hasTombstone", "listTombstones", "removeTombstone",
];

// wrapBackend(inner, overrides) -- a complete backend delegating every method to
// `inner`, with named methods overridden. One home for the pass-through mock so
// a new backend method does not mean editing a dozen hand-built objects.
export function wrapBackend(inner, overrides = {}) {
  const backend = {};
  for (const m of BACKEND_METHODS) backend[m] = (...a) => inner[m](...a);
  return Object.assign(backend, overrides);
}

// corruptingReadBackend(inner, tampered) -- a backend whose read() opens the REAL
// stored blob (so a missing entry still throws RefNotFound and the disk read path is
// exercised end to end) then serves `tampered` bytes in its place -- the storage-rot
// case the verifying read stream exists to catch. It DESTROYS the opened stream
// rather than abandoning it, closing the FileHandle it will not use: an undrained
// handle lingers until GC, and a FileHandle closed by GC is a hard error on newer
// Node -- a fixture closes what it opens (the same discipline as the claim
// substitutions' c.source.destroy()).
export function corruptingReadBackend(inner, tampered = "tampered bytes") {
  return wrapBackend(inner, {
    read: async (id) => {
      const real = await inner.read(id);
      real.destroy();
      return Readable.from([Buffer.from(tampered)]);
    },
  });
}

// retryClaimed(fn) -- run a claimed read, retrying while it loses the claim race
// (RefClaimed). The budget vectors race N readers on one entry; the losers of
// each round retry until the entry is exhausted (then RefNotFound ends it). The
// retry yields to the MACROTASK queue (setImmediate), not a bare microtask spin:
// a tight microtask retry loop would starve the claim holder's stream drain (it
// advances on IO/macrotasks) and livelock -- nobody makes progress.
export async function retryClaimed(fn) {
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RefClaimed) {
        await new Promise((r) => setImmediate(r));
        continue;
      }
      throw err;
    }
  }
}
