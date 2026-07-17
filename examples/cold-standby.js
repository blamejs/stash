// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Cold-standby replication: mirror a store for durability without ever
// resurrecting a destroyed entry.
//
//   node examples/cold-standby.js
//
// StashJS ships only the primitives replication needs -- store(), tombstones(),
// drop() -- and none of the machinery: no sockets, no wire format, no schedule.
// The daemon, the transport, and the topology are yours. This sketch is the
// SAFE topology: one primary serves every read, a standby holds a copy for
// durability, and tombstones propagate outward so a pop on the primary is never
// undone by a later sync. It asserts every step (it runs in CI).
//
// The one setting you must get right is tombstoneTtl: it has to comfortably
// exceed the longest gap between reconciliations, or a grave is pruned before
// the standby has seen it and the id could come back. Size it against your
// slowest replica, not an arbitrary number.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { Stash } from "@blamejs/stash";
import { MemoryBackend } from "@blamejs/stash/backends/memory";

const log = (...args) => console.log(...args);

// Two independent stores. In a real deployment these are separate processes on
// separate hosts, each owning its own disk root; here they are two in-memory
// stores in one process. A long tombstoneTtl keeps graves around well past the
// sync interval.
const primary = new Stash({ backend: new MemoryBackend(), tombstoneTtl: "30d" });
const standby = new Stash({ backend: new MemoryBackend(), tombstoneTtl: "30d" });

const readAll = async (store, ref) => {
  const chunks = [];
  for await (const chunk of await store.apply(ref)) chunks.push(chunk);
  return Buffer.concat(chunks);
};

// One direction of a full-scan anti-entropy pass: propagate graves FIRST (so a
// store can never re-file an id the other side buried), then store each live
// entry. store() preserves the entry's identity -- id, expiry, read budget,
// meta -- and verifies the bytes against the supplied digest as they stream, so
// a repeated pass is a free no-op and transfer corruption is caught on the way
// in. The transport that carries `entry` and its bytes between hosts is yours.
async function syncOnce(from, to) {
  for (const grave of await from.tombstones()) await to.drop(grave.id);
  for (const entry of await from.list()) await to.store(entry, await readAll(from, entry.id));
}

// --- seed the primary and replicate to the standby ----------------------------
const alpha = await primary.push("alpha bytes", { meta: { name: "alpha" } });
const bravo = await primary.push("bravo bytes", { meta: { name: "bravo" } });
await syncOnce(primary, standby);
assert.deepEqual(await readAll(standby, alpha), Buffer.from("alpha bytes"), "standby holds alpha");
assert.deepEqual(await readAll(standby, bravo), Buffer.from("bravo bytes"), "standby holds bravo");
log("replicated 2 entries: primary -> standby");

// A repeated sync is free -- an identical store() is an idempotent no-op.
await syncOnce(primary, standby);
assert.equal((await standby.list()).length, 2, "re-syncing an identical store changes nothing");
log("re-sync is a no-op (idempotent store)");

// --- destroy on the primary, then converge ------------------------------------
// The primary pops bravo -- bytes out once, then gone, and a grave is left.
for await (const _chunk of await primary.pop(bravo)) void _chunk; // drain-and-destroy
assert.equal(await primary.has(bravo), false, "bravo popped on the primary");
const graves = await primary.tombstones();
assert.equal(graves.length, 1, "the pop left a grave");
assert.equal(graves[0].cause, "pop");

// Reconcile: the grave propagates to the standby, which drops its copy and
// refuses to accept bravo back.
await syncOnce(primary, standby);
assert.equal(await standby.has(bravo), false, "the grave propagated: standby dropped its copy");
log("popped bravo on primary -> grave propagated -> standby converged");

// --- a stale replica cannot resurrect a destroyed entry -----------------------
// Imagine a THIRD node that missed the pop and still holds a live bravo. Feeding
// its copy back through store() is refused by the grave -- no resurrection.
const stale = new Stash({ backend: new MemoryBackend(), tombstoneTtl: "30d" });
const bravoBytes = "bravo bytes";
const bravoEntry = {
  id: bravo,
  size: Buffer.byteLength(bravoBytes),
  digest: "sha256:" + createHash("sha256").update(bravoBytes).digest("hex"),
  createdAt: 1,
  expiresAt: null,
  reads: null,
  readsLeft: null,
  meta: { name: "bravo" },
};
assert.equal(await stale.store(bravoEntry, bravoBytes), true, "the stale node still has a live copy");
// The standby already carries bravo's grave, so a sync FROM the stale node is refused.
assert.equal(await standby.store(bravoEntry, bravoBytes), false, "the grave refuses the resurrection");
await assert.rejects(standby.show(bravo), (err) => err.code === "ENOREF");
log("a stale node's live copy is refused by the grave -- no resurrection");

log("\ncold-standby: replicated, destroyed, converged, and proved no resurrection. OK");
