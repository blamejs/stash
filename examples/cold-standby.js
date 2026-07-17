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

// The bytes travel with the entry over YOUR transport. Replication does NOT read
// them back with apply(): apply() spends a read budget and would DESTROY a reads:1
// entry mid-sync. This sketch keeps the payloads the primary holds in a map; a real
// daemon ships each entry's bytes alongside its Entry over the wire.
const wire = new Map(); // id -> the bytes the primary holds
async function put(store, bytes, opts) {
  const ref = await store.push(bytes, opts);
  wire.set(ref, Buffer.from(bytes));
  return ref;
}

// A verification read only -- apply() is safe on an UNBUDGETED entry (it destroys
// nothing) and lets the example prove the replicated bytes actually round-trip. It
// is never the replication path (that would spend a budget); see `wire` above.
const readAll = async (store, ref) => {
  const chunks = [];
  for await (const chunk of await store.apply(ref)) chunks.push(chunk);
  return Buffer.concat(chunks);
};

// One direction of a full-scan anti-entropy pass: propagate graves FIRST (so a
// store can never re-file an id the other side buried), then store each live entry
// with the bytes from the transport. store() preserves the entry's identity -- id,
// expiry, read budget, meta -- verbatim and verifies the bytes against the supplied
// digest as they stream, so a repeated pass is a free no-op and transfer corruption
// is caught on the way in.
async function syncOnce(from, to) {
  for (const grave of await from.tombstones()) await to.drop(grave.id);
  for (const entry of await from.list()) await to.store(entry, wire.get(entry.id));
}

// --- seed the primary and replicate to the standby ----------------------------
const alpha = await put(primary, "alpha bytes", { meta: { name: "alpha" } });
const bravo = await put(primary, "bravo bytes", { meta: { name: "bravo" } });
// A budgeted entry replicates through the SAME path -- store() files it with its
// remaining read budget intact, because the bytes came from the transport, not from
// a budget-spending apply().
const budgeted = await put(primary, "read me twice", { reads: 2, meta: { name: "budgeted" } });
await syncOnce(primary, standby);
assert.deepEqual(await readAll(standby, alpha), Buffer.from("alpha bytes"), "standby holds alpha");
assert.deepEqual(await readAll(standby, bravo), Buffer.from("bravo bytes"), "standby holds bravo");
// The read budget survived the copy verbatim (show() is metadata-only, it spends
// nothing), AND the sync did not spend the PRIMARY's budget -- reading via apply()
// for replication would have (this is why syncOnce reads from `wire`, not apply).
assert.equal((await standby.show(budgeted)).readsLeft, 2, "the read budget survived replication");
assert.equal((await primary.show(budgeted)).readsLeft, 2, "the sync did NOT spend the primary's budget");
log("replicated 3 entries (one budgeted): primary -> standby, budgets intact");
// A reads:1 entry replicated to two nodes could serve one read on EACH before their
// tombstones converge -- exactly-once becomes eventually-once. That is why the safe
// topology serves every read from one node (the primary) and keeps the standby cold.

// A repeated sync is free -- an identical store() is an idempotent no-op.
await syncOnce(primary, standby);
assert.equal((await standby.list()).length, 3, "re-syncing an identical store changes nothing");
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

log("\ncold-standby: replicated (budgets intact), destroyed, converged, and proved no resurrection. OK");
