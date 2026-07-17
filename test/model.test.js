// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Property / model-based test: a stateful reference ORACLE predicts the store's
// observable state, and a seeded random op sequence is replayed against BOTH real
// backends, asserting after every op that has/list/stats/tombstones agree with the
// oracle and that the monotone and no-resurrection invariants hold. Coverage is the
// vehicle; a divergence is either a store bug or an oracle bug -- the shrinker
// reports the minimal reproducing prefix and the seed so it can be pinned.
//
// The model is SEQUENTIAL (one awaited op at a time), so there is no claim race --
// concurrency is the chaos suite's subject. It uses non-expiring entries so the
// oracle is exact without a clock the store does not expose (expiry has its own
// deterministic vectors). It reuses the store's own tombstone CAUSES so the cause
// prediction cannot silently drift.

import { suite, test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { Stash } from "../src/index.js";
import { CAUSES } from "../src/entry.js";
import { BACKENDS, drain, makeStoredEntry } from "./_helpers.js";
import { cleanupScratch } from "./_scratch.js";

after(() => cleanupScratch());

// A deterministic LCG (the fuzz harness's shape), so every run and every shrink
// step is reproducible from the seed.
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const OPS = ["push", "apply", "pop", "drop", "storeOnGrave", "clear"];
const payload = (n) => Buffer.from("payload-" + n + "-" + "y".repeat(n % 24));
const digestOf = (buf) => "sha256:" + createHash("sha256").update(buf).digest("hex");

// A generated op: { op, ... } chosen by the rng over a small budget of pushes so
// re-pushes, budget exhaustion, and store-onto-grave actually happen.
function genSequence(rng, length) {
  const seq = [];
  let counter = 0;
  for (let i = 0; i < length; i += 1) {
    const op = OPS[Math.floor(rng() * OPS.length)];
    if (op === "push") {
      const readsPick = Math.floor(rng() * 4); // 0 -> unlimited, else a 1..3 budget
      seq.push({ op, n: counter++, reads: readsPick === 0 ? null : readsPick });
    } else {
      seq.push({ op, pick: rng() });
    }
  }
  return seq;
}

// The oracle: live = id -> { readsLeft, digest }, graves = id -> cause. It predicts
// the observable state; the harness asserts the real store matches it after each op.
function newOracle() {
  return { live: new Map(), graves: new Map() };
}

function pickFrom(map, r) {
  const keys = [...map.keys()];
  return keys.length === 0 ? null : keys[Math.floor(r * keys.length)];
}

// applyOp(stash, oracle, step) -- run one op on the real store AND the oracle. Any
// throw propagates so the caller can localize it; the invariants are checked by the
// caller after the op returns.
async function applyOp(stash, oracle, step) {
  const { live, graves } = oracle;
  switch (step.op) {
    case "push": {
      const buf = payload(step.n);
      const ref = await stash.push(buf, step.reads === null ? {} : { reads: step.reads });
      live.set(ref, { readsLeft: step.reads, digest: digestOf(buf) });
      break;
    }
    case "apply": {
      const ref = pickFrom(live, step.pick);
      if (ref === null) break;
      await drain(await stash.apply(ref));
      const entry = live.get(ref);
      if (entry.readsLeft !== null) {
        entry.readsLeft -= 1;
        if (entry.readsLeft === 0) {
          live.delete(ref);
          graves.set(ref, "spent");
        }
      }
      break;
    }
    case "pop": {
      const ref = pickFrom(live, step.pick);
      if (ref === null) break;
      await drain(await stash.pop(ref));
      live.delete(ref);
      graves.set(ref, "pop");
      break;
    }
    case "drop": {
      const ref = pickFrom(live, step.pick);
      if (ref === null) break;
      const dropped = await stash.drop(ref);
      assert.equal(dropped, true, "drop of a live entry returns true");
      live.delete(ref);
      graves.set(ref, "drop");
      break;
    }
    case "storeOnGrave": {
      const ref = pickFrom(graves, step.pick);
      if (ref === null) break;
      const bytes = payload(999);
      const landed = await stash.store(makeStoredEntry(ref, bytes, { digest: digestOf(bytes) }), bytes);
      assert.equal(landed, false, "store onto a tombstoned id is refused -- no resurrection");
      break;
    }
    case "clear": {
      await stash.clear();
      for (const ref of live.keys()) graves.set(ref, "clear");
      live.clear();
      break;
    }
    default:
      throw new Error("unknown op " + step.op);
  }
}

// checkInvariants(stash, oracle) -- the observable state matches the oracle, and the
// monotone + no-resurrection invariants hold. Throws on the first divergence.
async function checkInvariants(stash, oracle) {
  const { live, graves } = oracle;
  const stats = await stash.stats();
  assert.equal(stats.entries, live.size, "stats.entries matches the oracle live count");

  const listed = new Set((await stash.list()).map((e) => e.id));
  assert.deepEqual([...listed].sort(), [...live.keys()].sort(), "list ids match the oracle live set");

  const gravedIds = new Set((await stash.tombstones()).map((g) => g.id));
  assert.deepEqual([...gravedIds].sort(), [...graves.keys()].sort(), "tombstone ids match the oracle graves");

  for (const [ref, cause] of graves) {
    assert.ok(CAUSES.includes(cause), "the predicted cause is a real CAUSES member");
    assert.equal(live.has(ref), false, "a tombstoned id is never live (no resurrection)");
    assert.equal(await stash.has(ref), false, "has() is false for a tombstoned id");
  }
  for (const ref of live.keys()) {
    assert.equal(await stash.has(ref), true, "has() is true for a live id");
    const entry = live.get(ref);
    // The store's readsLeft matches the oracle's monotonically-decremented value:
    // the oracle only ever decrements it, so any increase in the store would diverge.
    assert.equal((await stash.show(ref)).readsLeft, entry.readsLeft, "readsLeft matches the oracle (monotone)");
  }
  // A grave's real cause matches the oracle's prediction.
  for (const g of await stash.tombstones()) {
    assert.equal(g.cause, graves.get(g.id), "the tombstone cause matches the oracle");
  }
}

// runSequence(create, seq) -> null on success, or { at, error } at the first
// diverging op (for the shrinker).
async function runSequence(create, seq) {
  const stash = new Stash({ backend: create(), sweepInterval: null });
  const oracle = newOracle();
  try {
    for (let i = 0; i < seq.length; i += 1) {
      await applyOp(stash, oracle, seq[i]);
      await checkInvariants(stash, oracle);
    }
    return null;
  } catch (error) {
    return { error };
  } finally {
    await stash.close();
  }
}

// shrink(create, seq) -> the shortest failing prefix. A prefix is the simplest
// reduction that preserves reproducibility for a sequential model (a later op
// cannot cause an earlier assertion), so a linear scan for the first failing length
// is both minimal and cheap.
async function shrink(create, seq) {
  for (let len = 1; len <= seq.length; len += 1) {
    if ((await runSequence(create, seq.slice(0, len))) !== null) return seq.slice(0, len);
  }
  return seq;
}

const SEED = 0x5715ca7; // fixed for a deterministic CI; a failure reproduces from it.
const SEQ_LENGTH = 200;

for (const { name, create } of BACKENDS) {
  suite("model: " + name, () => {
    test("a random lifecycle sequence keeps the store in sync with the oracle", async () => {
      const seq = genSequence(lcg(SEED), SEQ_LENGTH);
      const result = await runSequence(create, seq);
      if (result !== null) {
        const minimal = await shrink(create, seq);
        assert.fail(
          "model divergence (seed " + SEED + ", minimal failing length " + minimal.length + "): " +
          (result.error && result.error.message) + "\n" + JSON.stringify(minimal),
        );
      }
    });

    test("a short scripted sequence exercises push -> apply-budget -> pop -> store-on-grave", async () => {
      const stash = new Stash({ backend: create(), sweepInterval: null });
      try {
        const a = await stash.push("budgeted", { reads: 2 });
        await drain(await stash.apply(a)); // readsLeft 2 -> 1
        assert.equal((await stash.show(a)).readsLeft, 1);
        await drain(await stash.apply(a)); // readsLeft 1 -> 0 -> destroyed + tombstoned
        assert.equal(await stash.has(a), false);
        assert.ok((await stash.tombstones()).some((g) => g.id === a && g.cause === "spent"));
        const bytes = Buffer.from("resurrect?");
        assert.equal(await stash.store(makeStoredEntry(a, bytes, { digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") }), bytes), false);
      } finally {
        await stash.close();
      }
    });
  });
}
