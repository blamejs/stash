// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Lifecycle walkthrough: the whole arc of an entry, from push to gone.
//
//   node examples/lifecycle.js
//
// It uses the in-memory backend so it needs no disk and no flags, and it
// asserts every step with node:assert so a regression fails the example
// loudly (it is run in CI). Everything here is the same shipped surface a
// disk-backed store exposes -- one conformance suite runs against both.

import assert from "node:assert/strict";

import { Stash } from "@blamejs/stash";
import { MemoryBackend } from "@blamejs/stash/backends/memory";

const log = (...args) => console.log(...args);

// A Stash holds POLICY (lifecycle, limits, integrity); the backend holds the
// bytes. Construct one over the in-memory backend.
const stash = new Stash({ backend: new MemoryBackend() });

// --- push: bytes in, a random-capability ref out ------------------------------
// The ref is 'v1_' + 256 bits of randomness -- never a hash of the content, so
// holding a suspect document never lets anyone probe whether it is stored.
const ref = await stash.push("the ciphertext your layer above produced", {
  meta: { kind: "drop" },
});
assert.match(ref, /^v1_[A-Za-z0-9_-]{43}$/);
log("pushed ->", ref);

// --- show: metadata only, never the bytes -------------------------------------
const entry = await stash.show(ref);
assert.equal(entry.meta.kind, "drop");
log("show   ->", { size: entry.size, meta: entry.meta });

// --- apply: a digest-verified read that does NOT destroy ----------------------
// apply streams the bytes and verifies the digest as it drains; the entry
// survives, so you can apply again.
const readOnce = async () => {
  const chunks = [];
  for await (const chunk of await stash.apply(ref)) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};
// Read it TWICE, asserting each drain -- an unbudgeted entry survives every read,
// so the second apply must return the same bytes (a regression that destroyed it
// on a later read would fail here, not slip past a single unchecked read).
assert.equal(await readOnce(), "the ciphertext your layer above produced");
assert.equal(await readOnce(), "the ciphertext your layer above produced", "apply is repeatable -- the entry survives a read");
assert.equal(await stash.has(ref), true, "apply does not destroy");
log("applied twice, entry still present");

// --- pop: read once, then it is gone ------------------------------------------
// pop streams the entry and destroys it the instant the stream drains cleanly.
const popped = [];
for await (const chunk of await stash.pop(ref)) popped.push(chunk);
assert.equal(Buffer.concat(popped).toString("utf8"), "the ciphertext your layer above produced");
assert.equal(await stash.has(ref), false, "pop destroyed it");
log("popped -> gone");

// --- read budgets: a finite number of reads, then self-destruct ---------------
// push(_, { reads: N }) gives an entry N successful apply drains; the read that
// spends the last credit destroys it. A failed/abandoned read costs nothing.
const budgeted = await stash.push("read me twice", { reads: 2 });
for (let i = 1; i <= 2; i += 1) {
  const out = [];
  for await (const chunk of await stash.apply(budgeted)) out.push(chunk);
  assert.equal(Buffer.concat(out).toString("utf8"), "read me twice");
}
assert.equal(await stash.has(budgeted), false, "the budget-exhausting read destroyed it");
log("read budget spent -> gone");

// --- expiry: terms are fixed at push and only ever move toward destruction ----
// A ttl stamps expiresAt once; an expired entry reads back as gone and is
// dropped in passing, before any sweep. There is no touch() and no extend.
const shortLived = await stash.push("expires immediately", { ttl: 0 });
await assert.rejects(stash.show(shortLived), (err) => err.code === "ENOREF");
assert.equal(await stash.has(shortLived), false, "an expired entry is gone on read");
log("expired entry read back as gone");

// --- prune / clear: janitorial destruction ------------------------------------
await stash.push("a", { ttl: 0 });
await stash.push("b", { ttl: 0 });
const reaped = await stash.prune(); // reap expired on demand
assert.equal(reaped, 2, "prune returns the real destruction count");
const live = await stash.push("still here");
assert.equal(await stash.clear(), 1, "clear destroys everything and counts the live ones");
assert.equal(await stash.has(live), false);
log("pruned expired, cleared the rest");

log("\nlifecycle: every step asserted, entry destroyed at each terminal. OK");
