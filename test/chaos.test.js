// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Chaos / fault injection: fault each backend method a verb depends on, and abort
// reads/writes mid-stream, asserting the store fails CLOSED every time -- a typed
// error (never a raw throw), no orphan left listed, no resurrection of a destroyed
// id, and (via the corrupting-read discipline) no leaked handle. These vectors
// largely PROVE the existing fail-closed guards; a raw throw, an orphan, or a
// resurrection surfaced here is a real bug to root-cause. Runs against both backends.

import { suite, test, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { Stash, IntegrityError } from "../src/index.js";
import { MemoryBackend } from "../src/backends/memory.js";
import { generate } from "../src/ref.js";
import { C } from "../src/constants.js";
import { BACKENDS, drain, makeStoredEntry, wrapBackend, pollUntil } from "./_helpers.js";
import { cleanupScratch } from "./_scratch.js";
import { createHash } from "node:crypto";

after(() => cleanupScratch());

const digestOf = (bytes) => "sha256:" + createHash("sha256").update(Buffer.from(bytes)).digest("hex");

// A source that yields `chunks` chunks of `size` then ERRORS -- a producer that dies
// mid-push. The push must leave nothing on disk (SPEC.md 8 partial-write cleanup).
function erroringSource(size, chunks) {
  let emitted = 0;
  return new Readable({
    read() {
      if (emitted >= chunks) {
        this.destroy(new Error("source died mid-stream"));
        return;
      }
      emitted += 1;
      this.push(Buffer.alloc(size, 0x7a));
    },
  });
}

// abortRead(readable) -- a reader that walks away: destroy the stream (an abort). Do
// NOT await 'close' -- a Readable with emitClose:false (SPEC.md 9 permits it) emits
// nothing on destroy, so waiting would hang; the claim resolves in the background and
// the caller polls the observable outcome. The premature destroy errors the stream --
// swallow it (mirrors the conformance premature-destroy vectors).
function abortRead(readable) {
  readable.on("error", () => {});
  readable.destroy();
}

// present(stash, ref) -- poll predicate tolerant of the transient claim state (show
// throws RefClaimed/RefNotFound while a claim resolves).
async function present(stash, ref) {
  try { await stash.show(ref); return true; } catch { return false; }
}

// applyDrain(stash, ref) -- apply+drain, retrying past a transient RefClaimed
// (ECLAIMED) with a BOUNDED poll: after an aborted pop restores, the sidecar is
// readable (show succeeds) a beat before the claim fully releases, so a bare apply
// races ECLAIMED. A genuinely destroyed entry throws RefNotFound, which propagates
// (the poll rejects), so a burn under a restore expectation still fails loudly.
async function applyDrain(stash, ref) {
  let out;
  await pollUntil(async () => {
    try { out = await drain(await stash.apply(ref)); return true; }
    catch (e) { if (e && e.code === "ECLAIMED") return false; throw e; }
  });
  return out;
}

for (const { name, create } of BACKENDS) {
  suite("chaos: " + name, () => {
    // --- Part A: a fault at each backend method a verb depends on fails closed. ---

    test("push fails closed when the backend write throws -- nothing is listed", async () => {
      const inner = create();
      const backend = wrapBackend(inner, { write: () => { throw new Error("write fault"); } });
      const stash = new Stash({ backend, sweepInterval: null });
      await assert.rejects(stash.push("bytes"), (e) => e instanceof Error);
      assert.deepEqual(await stash.list(), [], "a failed push orphans nothing");
      await stash.close();
    });

    test("apply fails closed when the backend read throws -- the entry survives", async () => {
      const inner = create();
      let faultOn = false;
      const backend = wrapBackend(inner, { read: (...a) => { if (faultOn) throw new Error("read fault"); return inner.read(...a); } });
      const stash = new Stash({ backend, sweepInterval: null });
      const ref = await stash.push("survivor");
      faultOn = true;
      await assert.rejects(stash.apply(ref), (e) => e instanceof Error);
      faultOn = false;
      assert.equal(await stash.has(ref), true, "a failed read leaves the entry intact");
      assert.deepEqual(await drain(await stash.apply(ref)), Buffer.from("survivor"));
      await stash.close();
    });

    test("pop fails closed when the backend claim throws -- the entry is not destroyed", async () => {
      const inner = create();
      let faultOn = false;
      const backend = wrapBackend(inner, { claim: (...a) => { if (faultOn) throw new Error("claim fault"); return inner.claim(...a); } });
      const stash = new Stash({ backend, sweepInterval: null });
      const ref = await stash.push("keep me");
      faultOn = true;
      await assert.rejects(stash.pop(ref), (e) => e instanceof Error);
      faultOn = false;
      assert.equal(await stash.has(ref), true, "a failed claim leaves the entry alive");
      await stash.close();
    });

    test("store fails closed when the backend write throws -- nothing lands", async () => {
      const inner = create();
      let faultOn = false;
      const backend = wrapBackend(inner, { write: (...a) => { if (faultOn) throw new Error("write fault"); return inner.write(...a); } });
      const stash = new Stash({ backend, sweepInterval: null });
      const bytes = Buffer.from("replicated");
      const freshId = generate(); // an absent id, so store reaches the (faulting) write
      faultOn = true;
      await assert.rejects(stash.store(makeStoredEntry(freshId, bytes, { digest: digestOf(bytes) }), bytes), (e) => e instanceof Error);
      faultOn = false;
      assert.equal(await stash.has(freshId), false, "a failed store lands nothing");
      assert.deepEqual(await stash.list(), [], "and orphans nothing");
      await stash.close();
    });

    // --- Part B: mid-stream aborts. ---

    test("a push whose source dies mid-stream leaves nothing on the store (SPEC.md 8)", async () => {
      const stash = new Stash({ backend: create(), sweepInterval: null });
      await assert.rejects(stash.push(erroringSource(16 * C.BYTES.KIB, 3)), (e) => e instanceof Error);
      assert.deepEqual(await stash.list(), [], "a torn push is not left listed");
      await stash.close();
    });

    test("a budgeted apply aborted mid-drain spends NO read (SPEC.md 4.1)", { timeout: 10000 }, async () => {
      const stash = new Stash({ backend: create(), sweepInterval: null });
      const big = Buffer.alloc(256 * C.BYTES.KIB, 0x62);
      const ref = await stash.push(big, { reads: 2 });
      abortRead(await stash.apply(ref)); // walk away mid-drain
      // The claim resolves asynchronously; poll (tolerating the claim state) for the
      // restored, undebited budget. Bounded, so a failed restore fails the test rather
      // than spinning.
      await pollUntil(async () => { try { return (await stash.show(ref)).readsLeft === 2; } catch { return false; } });
      assert.equal((await stash.show(ref)).readsLeft, 2, "an abandoned read costs no budget");
      assert.deepEqual(await applyDrain(stash, ref), big, "and a later full read still works");
      await stash.close();
    });

    test("a pop aborted mid-drain restores under the default policy; the entry survives", { timeout: 10000 }, async () => {
      const stash = new Stash({ backend: create(), sweepInterval: null }); // onPopFailure defaults to restore
      const big = Buffer.alloc(256 * C.BYTES.KIB, 0x63);
      const ref = await stash.push(big);
      abortRead(await stash.pop(ref));
      await pollUntil(async () => present(stash, ref)); // bounded: the restore lands, entry live again
      assert.deepEqual(await applyDrain(stash, ref), big, "a torn pop restored the entry, no bytes lost");
      await stash.close();
    });

    test("a pop aborted mid-drain under 'burn' destroys the entry", { timeout: 10000 }, async () => {
      const stash = new Stash({ backend: create(), sweepInterval: null, onPopFailure: "burn" });
      const big = Buffer.alloc(256 * C.BYTES.KIB, 0x64);
      const ref = await stash.push(big);
      abortRead(await stash.pop(ref));
      await pollUntil(async () => !(await present(stash, ref))); // poll until show() throws (burned)
      assert.equal(await stash.has(ref), false, "a torn pop under burn destroys the entry");
      assert.ok((await stash.tombstones()).some((g) => g.id === ref), "a burned entry leaves a grave -- no resurrection");
      await stash.close();
    });

    // A forward wall-clock step (NTP correction, VM resume) ages a young claim past
    // claimTimeout, so a live reader's claim looks abandoned to recovery -- which
    // would burn (or restore) a once-only read the reader is still draining (SPEC.md
    // 6). Recovery reclaims ONLY orphans (no live in-process holder); a claim a live
    // drain holds is never age-reclaimed. Simulated with a small claimTimeout and a
    // reader parked mid-drain past the lease -- the same age-past-lease condition a
    // forward step produces. A young orphan claim from a "crashed prior run" schedules
    // the recovery re-scan and proves crash recovery is untouched: it IS reclaimed.
    test("recovery never reclaims a claim a live reader is mid-drain on; an orphan still is (SPEC.md 6)", { timeout: 10000 }, async () => {
      const inner = create();
      // A prior process pushed both entries, then "crashed" holding a claim on the
      // orphan (crash residue the new process must recover). Claiming through the raw
      // backend leaves a claim the process Stash never tracked -- a genuine orphan.
      const setup = new Stash({ backend: inner, sweepInterval: null });
      const orphanRef = await setup.push("orphan-data");
      // A MULTI-CHUNK live entry so the read backpressures with no consumer -- genuinely
      // mid-drain -- on BOTH backends: the memory backend streams a single buffer as ONE
      // chunk, which under 'burn' (whose read holds the first byte until its delivery is
      // recorded) would drain into the stream buffer and self-complete rather than stay held.
      const big = Buffer.alloc(256 * C.BYTES.KIB, 0x65);
      async function* liveChunks() { for (let i = 0; i < big.length; i += 64 * C.BYTES.KIB) yield big.subarray(i, i + 64 * C.BYTES.KIB); }
      const liveRef = await setup.push(liveChunks());
      const orphanClaim = await inner.claim(orphanRef); // the crashed prior run's abandoned claim
      orphanClaim.source.on("error", () => {});
      orphanClaim.source.destroy(); // close the read handle; the claim file itself remains
      await inner.markDelivered(orphanRef); // it delivered a byte before crashing, so burn (its grave is the recovery-fired signal)

      // The new process. A short lease + a reader parked past it reproduces the
      // forward-step condition (a live claim aged past claimTimeout).
      const stash = new Stash({ backend: inner, sweepInterval: null, onPopFailure: "burn", claimTimeout: 50 });
      let ended = false;
      const stream = await stash.pop(liveRef); // pop's first #recover sees the young orphan -> schedules a re-scan
      stream.on("error", () => {});
      stream.on("end", () => { ended = true; });
      // Deliberately do NOT consume the stream: the reader holds the claim mid-drain,
      // longer than the lease, exactly as a slow drain crossing a forward step would.

      // Wait past the lease for recovery to re-run, and confirm it fired by the orphan's
      // grave. Crash recovery is untouched: the orphan (no live holder) IS reclaimed.
      await pollUntil(async () => (await stash.tombstones()).some((g) => g.id === orphanRef));
      assert.equal(ended, false, "the live reader has not completed -- its claim is genuinely mid-drain");
      assert.equal(await inner.isClaimed(liveRef), true, "the live reader's claim survived the recovery re-scan");
      assert.equal((await stash.tombstones()).some((g) => g.id === liveRef), false,
        "recovery did NOT burn a claim a live reader still holds");

      // And the parked read still completes: bytes out once, then the entry is gone --
      // the once-only read is intact, not lost to a spurious reclaim.
      assert.deepEqual(await drain(stream), big, "the mid-drain read completes with the full, correct bytes");
      await pollUntil(async () => !(await present(stash, liveRef)));
      assert.ok((await stash.tombstones()).some((g) => g.id === liveRef), "the reader's own pop destroyed it exactly once");
      await stash.close();
    });

    test("recovery RESTORES a never-delivered orphan even under 'burn' -- a crash before any byte reached a consumer is not an observation (SPEC.md 6)", { timeout: 10000 }, async () => {
      // burn destroys an entry because "a read attempt means the bytes may have been
      // observed". A process that claimed then crashed WITHOUT streaming a byte observed
      // nothing, so recovery must RESTORE it, not burn it -- otherwise a crash silently
      // destroys never-read data. The claim below never has markDelivered called on it,
      // so it is a zero-observation orphan; under burn it must come back, not die.
      const inner = create();
      const setup = new Stash({ backend: inner, sweepInterval: null });
      const ref = await setup.push("never-observed bytes");
      const orphan = await inner.claim(ref); // a prior run claimed it...
      orphan.source.on("error", () => {});
      orphan.source.destroy(); // ...and crashed WITHOUT streaming a byte (no markDelivered)

      const stash = new Stash({ backend: inner, sweepInterval: null, onPopFailure: "burn", claimTimeout: 50 });
      await pollUntil(async () => { await stash.list(); return !(await inner.isClaimed(ref)); }); // recovery resolves the orphan
      assert.equal(await stash.has(ref), true, "a never-delivered orphan is restored, not burned");
      assert.equal((await stash.tombstones()).some((g) => g.id === ref), false, "no grave -- nothing was observed to destroy");
      assert.deepEqual(await applyDrain(stash, ref), Buffer.from("never-observed bytes"), "the restored entry reads back intact");
      await stash.close();
    });

    test("recovery BURNS a delivered orphan under 'burn' -- a byte that reached a consumer is an observation (SPEC.md 6)", { timeout: 10000 }, async () => {
      // The other side of delivery-gating: once a byte has been handed to a consumer, the
      // burn rationale holds -- recovery of a crashed delivered claim destroys the entry.
      const inner = create();
      const setup = new Stash({ backend: inner, sweepInterval: null });
      const ref = await setup.push("observed bytes");
      const orphan = await inner.claim(ref);
      orphan.source.on("error", () => {});
      orphan.source.destroy();
      await inner.markDelivered(ref); // a byte reached a consumer before the crash

      const stash = new Stash({ backend: inner, sweepInterval: null, onPopFailure: "burn", claimTimeout: 50 });
      await pollUntil(async () => { await stash.list(); return (await stash.tombstones()).some((g) => g.id === ref); });
      assert.equal(await stash.has(ref), false, "a delivered orphan is burned");
      assert.ok((await stash.tombstones()).some((g) => g.id === ref), "a burned entry leaves a grave -- no resurrection");
      await stash.close();
    });

    test("under 'burn', a byte reaches the consumer only AFTER its delivery is recorded -- no fire-and-forget race leaves a stale marker (SPEC.md 6)", async () => {
      // The mark must be durable BEFORE the first byte is released, not fire-and-forget: a
      // mark landing late (after a budgeted read's restore cleared the marker) would leave a
      // stale marker that makes a later never-delivered re-claim of the same id get BURNED --
      // destroying never-read data. Delaying markDelivered proves the byte waits for it.
      const inner = create();
      let marked = false;
      let deliveredBeforeMark = false;
      const backend = wrapBackend(inner, {
        markDelivered: async (id) => { await new Promise((r) => setImmediate(r)); marked = true; return inner.markDelivered(id); },
      });
      const stash = new Stash({ backend, sweepInterval: null, onPopFailure: "burn" });
      const ref = await stash.push("observed payload");
      const stream = await stash.pop(ref);
      stream.on("data", () => { if (!marked) deliveredBeforeMark = true; });
      await drain(stream);
      assert.equal(deliveredBeforeMark, false, "no byte reached the consumer before markDelivered recorded it");
      assert.equal(marked, true, "markDelivered ran");
      await stash.close();
    });

    test("a budgeted id re-claimed after a restore starts UNDELIVERED, so a never-delivered crash restores (SPEC.md 6)", { timeout: 10000 }, async () => {
      // The data-loss path the delivery-mark exists to prevent: a { reads: 2 } entry under
      // 'burn' is applied once (marks delivered, then restore debits the budget), then
      // re-claimed for the second read; if that re-claim inherited the first read's delivered
      // flag, a crash before streaming a byte would BURN it. A fresh claim must start clean.
      const inner = create();
      const stash = new Stash({ backend: inner, sweepInterval: null, onPopFailure: "burn", claimTimeout: 50 });
      const ref = await stash.push("budgeted", { reads: 2 });
      assert.deepEqual(await drain(await stash.apply(ref)), Buffer.from("budgeted")); // read 1: marks, then restores (debits 2->1)

      // A prior process now re-claims for read 2 and crashes before streaming a byte.
      const reclaim = await inner.claim(ref);
      reclaim.source.on("error", () => {});
      reclaim.source.destroy(); // never delivered on THIS claim

      const next = new Stash({ backend: inner, sweepInterval: null, onPopFailure: "burn", claimTimeout: 50 });
      await pollUntil(async () => { await next.list(); return !(await inner.isClaimed(ref)); });
      assert.equal(await next.has(ref), true, "the re-claim never delivered, so recovery restored it -- no stale mark burned it");
      assert.equal((await next.tombstones()).some((g) => g.id === ref), false, "no grave: nothing was observed on the re-claim");
      await next.close();
      await stash.close();
    });

    test("a FAULTED expired-restore in the claim window releases the live-claim guard, so recovery still reclaims the orphan (SPEC.md 6)", { timeout: 10000 }, async () => {
      // The early-expiry path in a claimed read (an entry live at the advisory #statLive
      // but lapsed by the time the claim is won -- fragile area 4) restores the claim and
      // drops the live-claim guard. If that restore FAULTS, the guard must still be
      // released -- otherwise the now-orphaned claim is pinned in the live set forever and
      // #recover can never reclaim it. A young crash-orphan schedules the re-scan that
      // goes on to reclaim the leaked claim.
      const inner = create();
      const setup = new Stash({ backend: inner, sweepInterval: null });
      const orphanRef = await setup.push("orphan"); // the young crash-orphan that bootstraps the re-scan
      const oc = await inner.claim(orphanRef);
      oc.source.on("error", () => {});
      oc.source.destroy();

      let failRestore = false;
      const backend = wrapBackend(inner, {
        // Reproduce the TOCTOU deterministically: the entry is LIVE at the advisory
        // #statLive but the claim resolves it as already lapsed, so #claimedRead takes
        // the early-expiry branch -- no clock racing.
        claim: async (...a) => { const r = await inner.claim(...a); return { ...r, entry: { ...r.entry, expiresAt: 1 } }; },
        restore: (...a) => { if (failRestore) throw new Error("restore boom"); return inner.restore(...a); },
      });
      const stash = new Stash({ backend, sweepInterval: null, onPopFailure: "burn", claimTimeout: 120 });
      const leakRef = await stash.push("expires", { reads: 1 }); // budgeted -> routes through #claimedRead

      failRestore = true;
      // apply claims leakRef, the wrapped claim reports it expired, the early-expiry
      // restore FAULTS -- which must still release the live-claim guard.
      await assert.rejects(stash.apply(leakRef));
      failRestore = false;

      // Past the lease, a verb re-runs #recover. It must reclaim leakRef's orphan (the
      // reader is gone, not live). A leaked guard would pin it and it would stay claimed.
      await pollUntil(async () => { await stash.prune(); return !(await inner.isClaimed(leakRef)); }, { timeout: 6000 });
      assert.equal(await inner.isClaimed(leakRef), false, "the faulted expired-restore did not pin leakRef in the live-claim guard");
      await stash.close();
    });

    test("a faulted claim resolution schedules its OWN recovery re-scan, so an orphan with no concurrent claim is still reclaimed (SPEC.md 6)", { timeout: 10000 }, async () => {
      // A resolution fault (here an early-expiry restore) leaves the on-disk claim an
      // orphan. Unlike the sibling tests there is NO other claim to have scheduled a
      // re-scan, so the faulted path must schedule one itself -- otherwise the orphan is
      // stranded ECLAIMED until restart (a scan whose only claims were live, or a fault
      // with no concurrent claim, both leave #nextRecoverAt at Infinity).
      const inner = create();
      let failRestore = false;
      const backend = wrapBackend(inner, {
        claim: async (...a) => { const r = await inner.claim(...a); return { ...r, entry: { ...r.entry, expiresAt: 1 } }; },
        restore: (...a) => { if (failRestore) throw new Error("restore boom"); return inner.restore(...a); },
      });
      const stash = new Stash({ backend, sweepInterval: null, onPopFailure: "burn", claimTimeout: 40 });
      const leakRef = await stash.push("expires", { reads: 1 });
      failRestore = true;
      await assert.rejects(stash.apply(leakRef)); // early-expiry restore faults, no other claim exists
      failRestore = false;
      await pollUntil(async () => { await stash.prune(); return !(await inner.isClaimed(leakRef)); }, { timeout: 4000 });
      assert.equal(await inner.isClaimed(leakRef), false, "orphan from a faulted restore with no concurrent claim is still reclaimed");
      await stash.close();
    });

    test("a faulted resolution's forced re-scan is not erased by an in-flight recovery scan writing back a stale deadline (SPEC.md 6)", { timeout: 15000 }, async () => {
      // The forced re-scan (deadline 0) a faulted resolution schedules must survive a
      // recovery scan that was ALREADY in flight when the fault fired: that scan listed
      // claims before the orphan existed, so its snapshotted deadline (here a live claim's
      // far-future lease) must NOT overwrite the forced 0. The scan is parked mid-resolve
      // via a backend barrier so the fault lands during it, deterministically.
      const CLAIM_TIMEOUT = 800; // large so the scan's stale deadline (now + lease) sits far beyond the reclaim poll
      const inner = create();
      const setup = new Stash({ backend: inner, sweepInterval: null });
      const orphanRef = await setup.push("orphan");
      const orphanClaimedAt = Date.now();
      const oc = await inner.claim(orphanRef); // young orphan: schedules the re-scan we will park
      oc.source.on("error", () => {});
      oc.source.destroy();
      const big = Buffer.alloc(256 * C.BYTES.KIB, 0x6a);
      const victimRef = await setup.push(big);

      let releaseScan;
      const scanGate = new Promise((r) => { releaseScan = r; });
      let parkInRestore = false;
      let scanParked = false;
      let failVictimCommit = false;
      const backend = wrapBackend(inner, {
        // Deterministic scan order: the live victim FIRST (skipped while guarded, before
        // the fault drops its guard), the stale orphan we park on LAST -- so the resumed
        // scan never revisits victim, and only the buggy end-of-scan deadline write can
        // decide whether the forced re-scan survives.
        listClaims: async () => {
          const claims = await inner.listClaims();
          const v = claims.find((c) => c.id === victimRef);
          const o = claims.find((c) => c.id === orphanRef);
          return [...(v ? [v] : []), ...claims.filter((c) => c.id !== victimRef && c.id !== orphanRef), ...(o ? [o] : [])];
        },
        restore: async (id) => {
          if (id === orphanRef && parkInRestore) { parkInRestore = false; scanParked = true; await scanGate; } // park the in-flight scan mid-resolve
          return inner.restore(id);
        },
        commit: async (id) => {
          if (id === victimRef && failVictimCommit) { failVictimCommit = false; throw new Error("commit boom"); }
          return inner.commit(id);
        },
      });
      const stash = new Stash({ backend, sweepInterval: null, claimTimeout: CLAIM_TIMEOUT }); // default restore policy
      const stream = await stash.pop(victimRef); // guards victim; pop's #recover scheduled a deadline from the young orphan
      stream.on("error", () => {});

      // Past the orphan's lease, the next verb re-runs #recover: it resolves the now-stale
      // orphan (parking there) and, skipping the live victim, snapshots a FUTURE deadline.
      const leaseDeadline = orphanClaimedAt + CLAIM_TIMEOUT + 40;
      while (Date.now() <= leaseDeadline) await new Promise((r) => setImmediate(r)); // bounded wait on the lease, not a sleep

      parkInRestore = true;
      const inflight = stash.list().catch(() => {}); // the in-flight scan; parks resolving the orphan
      // Generous window: reaching the park point runs a real disk recovery scan, which
      // under a loaded parallel run can take well past the 3s default. This is setup, not
      // the assertion -- the reclaim-speed discrimination is the tight poll below -- so a
      // long budget (within the test's 15s timeout) only tolerates a starved machine.
      await pollUntil(async () => scanParked, { timeout: 12000 });

      // With the scan parked mid-resolve, the pop's commit faults -> forced re-scan (deadline 0).
      failVictimCommit = true;
      await drain(stream).catch(() => {});

      releaseScan(); // the parked scan completes and would write back its stale future deadline
      await inflight;

      // The forced deadline must have survived, so the next verb reclaims victim's orphan
      // at once -- within this bounded poll, far shorter than the lease the stale deadline
      // would have imposed.
      await pollUntil(async () => { await stash.prune(); return !(await inner.isClaimed(victimRef)); }, { timeout: 200 });
      assert.equal(await inner.isClaimed(victimRef), false, "the in-flight scan did not erase the faulted resolution's forced re-scan");
      await stash.close();
    });

    test("two Stash over one store share the live-claim guard: one instance's recovery never reclaims the other's mid-drain read (SPEC.md 6)", { timeout: 10000 }, async () => {
      // Single-writer-per-root is the contract, but if a caller creates two Stash over the
      // same store the guard must still hold: instance B's crash recovery must not
      // age-reclaim a claim instance A's live reader holds -- otherwise a forward clock
      // step (here a claim parked past the lease) lets B restore/burn a once-only read A is
      // still draining. The guard is shared per backend identity, so B sees A's live claim.
      const CLAIM_TIMEOUT = 50;
      const backend = create();
      const a = new Stash({ backend, sweepInterval: null, claimTimeout: CLAIM_TIMEOUT });
      const b = new Stash({ backend, sweepInterval: null, claimTimeout: CLAIM_TIMEOUT }); // SAME store
      const big = Buffer.alloc(256 * C.BYTES.KIB, 0x6b);
      const ref = await a.push(big);
      const claimedAt = Date.now();
      const stream = await a.pop(ref); // A holds a live claim (the shared guard), mid-drain
      stream.on("error", () => {});

      // Past the lease, B's recovery scans A's now-aged claim. It must SKIP it (A holds it
      // live in the shared guard), not reclaim it. A bounded wall-clock poll on the lease.
      const deadline = claimedAt + CLAIM_TIMEOUT + 30;
      while (Date.now() <= deadline) await new Promise((r) => setImmediate(r));
      await b.prune(); // B's first #recover
      assert.equal(await backend.isClaimed(ref), true, "B's recovery did not reclaim A's live mid-drain claim");

      // And A's read completes intact and destroys the entry exactly once.
      assert.deepEqual(await drain(stream), big, "A's mid-drain read completes with the full bytes");
      await pollUntil(async () => !(await backend.isClaimed(ref)));
      await a.close();
      await b.close();
    });

    test("closing a Stash while its pop stream is still draining keeps the store's guard, so a later Stash's recovery does not reclaim the live claim (SPEC.md 6)", { timeout: 10000 }, async () => {
      // close() must not drop the shared guard while a claim is still live: a pop handed
      // back a stream, then close() was called before it drained. If the registry entry is
      // deleted, a later Stash over the same store gets an EMPTY guard and its recovery
      // reclaims the still-draining claim. The entry stays registered until the claim
      // settles, not merely until the last instance closes.
      const CLAIM_TIMEOUT = 50;
      const backend = create();
      const a = new Stash({ backend, sweepInterval: null, claimTimeout: CLAIM_TIMEOUT });
      const big = Buffer.alloc(256 * C.BYTES.KIB, 0x6c);
      const ref = await a.push(big);
      const claimedAt = Date.now();
      const stream = await a.pop(ref); // live claim, stream NOT drained
      stream.on("error", () => {});
      await a.close(); // closed while the claim is still live -- the guard must persist

      const b = new Stash({ backend, sweepInterval: null, claimTimeout: CLAIM_TIMEOUT }); // a LATER Stash over the same store
      const deadline = claimedAt + CLAIM_TIMEOUT + 30;
      while (Date.now() <= deadline) await new Promise((r) => setImmediate(r)); // bounded wait on the lease
      await b.prune(); // B's recovery must SKIP A's still-live claim
      assert.equal(await backend.isClaimed(ref), true, "the live claim survived a later Stash's recovery after close()");

      assert.deepEqual(await drain(stream), big, "A's read still completes with the full bytes");
      await pollUntil(async () => !(await backend.isClaimed(ref)));
      await b.close();
    });

    test("two Stash over one identity-less backend object share the live-claim guard (SPEC.md 6)", { timeout: 10000 }, async () => {
      // A backend that omits the optional `identity` (a custom or wrapper backend) still
      // needs its two openers to coordinate: the guard falls back to the backend OBJECT as
      // the key, so two Stash over the SAME instance see one another's live reads.
      const CLAIM_TIMEOUT = 50;
      const shared = wrapBackend(create()); // wrapBackend forwards no `identity` -> identity-less
      const a = new Stash({ backend: shared, sweepInterval: null, claimTimeout: CLAIM_TIMEOUT });
      const b = new Stash({ backend: shared, sweepInterval: null, claimTimeout: CLAIM_TIMEOUT }); // SAME object
      const big = Buffer.alloc(256 * C.BYTES.KIB, 0x6d);
      const ref = await a.push(big);
      const claimedAt = Date.now();
      const stream = await a.pop(ref); // A holds a live claim (the object-keyed shared guard)
      stream.on("error", () => {});
      const deadline = claimedAt + CLAIM_TIMEOUT + 30;
      while (Date.now() <= deadline) await new Promise((r) => setImmediate(r)); // bounded wait on the lease
      await b.prune();
      assert.equal(await shared.isClaimed(ref), true, "B's recovery skipped A's live claim over the shared identity-less backend");
      assert.deepEqual(await drain(stream), big, "A's read completes with the full bytes");
      await pollUntil(async () => !(await shared.isClaimed(ref)));
      await a.close();
      await b.close();
    });

    test("a claim age-reclaimed DURING acquisition (before its guard is recorded) cannot resurrect a once-only entry for a second reader (SPEC.md 6)", { timeout: 10000 }, async () => {
      // backend.claim() moves the blob into claims/ during its own awaits, BEFORE the
      // reader records the live-holder guard. If a #recover fires in that window -- a
      // young-orphan re-scan crossing a forward clock step -- it sees the fresh claim
      // backend.claim() moves the blob into claims/ during its own awaits, BEFORE the
      // reader records the live-holder guard. If a #recover fires in that window -- a
      // young-orphan re-scan crossing a forward clock step -- it sees the fresh claim
      // with no live holder and age-reclaims it: under the default restore policy the
      // once-only entry becomes readable again while the acquiring reader still holds
      // its open stream, so a SECOND reader can drain the same bytes. Reproduced with the
      // same forward-step mechanism as the mid-drain case above, but the reader is parked
      // INSIDE acquisition (after the on-disk claim, before the guard): a young orphan
      // schedules the re-scan, and once the lease passes the re-scan reports the fresh
      // claim aged (a forward step) so recovery restores it mid-acquisition.
      const CLAIM_TIMEOUT = 30;
      const inner = create();
      const setup = new Stash({ backend: inner, sweepInterval: null });
      const victim = Buffer.alloc(64 * C.BYTES.KIB, 0x67);
      const victimRef = await setup.push(victim, { reads: 1 }); // via setup, so `stash`'s first verb is the apply
      const orphanRef = await setup.push("orphan");
      const orphanClaimedAt = Date.now();
      const oc = await inner.claim(orphanRef); // young orphan: schedules the recovery re-scan
      oc.source.on("error", () => {});
      oc.source.destroy();

      let injected = false;
      let reportVictimStale = false;
      let stash;
      const backend = wrapBackend(inner, {
        claim: async (ref) => {
          const r = await inner.claim(ref); // ref's on-disk claim now exists
          if (ref === victimRef && !injected) {
            injected = true;
            // Park inside acquisition until the lease passes so the pending re-scan will
            // fire (a bounded poll on the wall clock, the forward-step condition -- not a
            // sleep-as-wait): the guard has NOT been recorded at this point.
            const deadline = orphanClaimedAt + CLAIM_TIMEOUT + 20;
            while (Date.now() <= deadline) await new Promise((res) => setImmediate(res));
            reportVictimStale = true;
            await stash.list(); // #recover re-runs past the lease and reclaims the fresh, unguarded claim
          }
          return r;
        },
        listClaims: async () => {
          const claims = await inner.listClaims();
          if (!reportVictimStale) return claims;
          // a forward clock step: the fresh claim reads as aged past the lease
          return claims.map((c) => (c.id === victimRef ? { ...c, claimedAt: c.claimedAt - 10 * 60_000 } : c));
        },
      });
      stash = new Stash({ backend, sweepInterval: null, claimTimeout: CLAIM_TIMEOUT }); // default restore policy

      const stream1 = await stash.apply(victimRef); // the injection fires during this acquisition
      stream1.on("error", () => {});
      // With the guard recorded only AFTER the claim, the injected #recover restored
      // victimRef, so this second reader claims and would drain the SAME once-only bytes.
      // With the guard recorded BEFORE acquisition, #recover skips it, the entry stays
      // claimed by stream1, and this second apply is refused.
      await assert.rejects(stash.apply(victimRef), "a second reader must not acquire a once-only entry another read holds");
      await drain(stream1).catch(() => {}); // stream1's own bytes + commit; tolerate a post-resurrection commit fault
      await stash.close();
    });

    test("a live claim SKIPPED by a recovery scan keeps recovery scheduled, so a later faulted resolution leaving an orphan is still reclaimed (SPEC.md 6)", { timeout: 10000 }, async () => {
      // When a recovery scan skips a claim because a live reader holds it, it must still
      // schedule a re-scan for when that claim would age out. Otherwise a scan whose only
      // remaining claims are live ends with #nextRecoverAt = Infinity, and if the reader's
      // terminal commit/restore later FAULTS -- dropping the guard but leaving the on-disk
      // claim as an orphan -- no scan is ever pending and the ref is stranded ECLAIMED
      // until restart. A young orphan triggers the mid-drain scan that skips the live
      // reader; the reader's commit then faults once, leaving an interrupted destruction.
      const CLAIM_TIMEOUT = 40;
      const inner = create();
      const setup = new Stash({ backend: inner, sweepInterval: null });
      const orphanRef = await setup.push("orphan");
      const oc = await inner.claim(orphanRef); // young orphan: triggers the mid-drain re-scan
      oc.source.on("error", () => {});
      oc.source.destroy();
      await inner.markDelivered(orphanRef); // delivered before crashing -> burn, so its grave marks the scan firing
      const big = Buffer.alloc(256 * C.BYTES.KIB, 0x68);
      const victimRef = await setup.push(big);

      let failCommitOnce = false;
      const backend = wrapBackend(inner, {
        commit: async (id) => {
          if (id === victimRef && failCommitOnce) { failCommitOnce = false; throw new Error("commit boom"); }
          return inner.commit(id);
        },
      });
      const stash = new Stash({ backend, sweepInterval: null, onPopFailure: "burn", claimTimeout: CLAIM_TIMEOUT });
      const stream = await stash.pop(victimRef); // guards victim + claims; pop's #recover saw the young orphan
      stream.on("error", () => {});

      // Past the orphan's lease, a verb fires the mid-drain scan: it reclaims the orphan
      // and SKIPS victim (live-guarded). Without rescheduling that skip, the scan ends
      // with #nextRecoverAt = Infinity.
      await pollUntil(async () => { await stash.prune(); return (await stash.tombstones()).some((g) => g.id === orphanRef); });

      // The reader now finishes, but its terminal commit FAULTS once, leaving victim an
      // orphan (grave written, claim not committed); the finally drops the guard.
      failCommitOnce = true;
      await drain(stream).catch(() => {});

      // A scheduled re-scan must finish victim's interrupted destruction. Stranded (poll
      // times out) without the reschedule; reclaimed with it.
      await pollUntil(async () => { await stash.prune(); return !(await inner.isClaimed(victimRef)); }, { timeout: 6000 });
      assert.equal(await inner.isClaimed(victimRef), false, "a skipped live claim that later orphans via a faulted commit is still reclaimed");
      await stash.close();
    });

    test("recovery resolves a corrupt-sidecar orphan claim instead of wedging every verb on EINTEGRITY (SPEC.md 6)", async () => {
      // A crash mid consumeRead leaves a stale orphan claim whose sidecar is unparsable,
      // so recovery's stat(id) throws IntegrityError. Recovery must FINISH the damaged
      // entry's destruction, never rethrow: #recover is memoized and every verb runs it
      // first, so a rethrow turns one corrupt claimed entry into a permanent store-wide
      // EINTEGRITY denial. Backend-agnostic (a Map holds no corrupt sidecar), so the
      // IntegrityError is injected on stat for the orphan and its staleness on listClaims;
      // the fix routes it to commit, the physical cleanup verify performs for a corrupt
      // sidecar -- no grave, since damage repair is not a lifecycle destruction.
      const inner = create();
      const setup = new Stash({ backend: inner, sweepInterval: null });
      const orphanRef = await setup.push("orphan-bytes");
      const orphanClaim = await inner.claim(orphanRef); // a prior run's abandoned claim
      orphanClaim.source.on("error", () => {});
      orphanClaim.source.destroy();

      let commits = 0;
      const backend = wrapBackend(inner, {
        // Report the fresh claim as long past its lease (a stale orphan) ...
        listClaims: async () => (await inner.listClaims()).map((c) => (c.id === orphanRef ? { ...c, claimedAt: c.claimedAt - 10 * 60_000 } : c)),
        // ... and make its sidecar unreadable, the crash-mid-rewrite corruption.
        stat: async (id) => { if (id === orphanRef) throw new IntegrityError("sidecar storage shape is damaged"); return inner.stat(id); },
        commit: async (id) => { if (id === orphanRef) commits += 1; return inner.commit(id); },
      });
      const stash = new Stash({ backend, sweepInterval: null, claimTimeout: 60_000 });

      // The first verb runs #recover: the orphan reads as stale, its stat throws
      // IntegrityError -- recovery must reap it (commit), not rethrow into a wedge.
      assert.deepEqual(await stash.list(), [], "recovery reaped the corrupt orphan; the store is not wedged");
      assert.equal(commits, 1, "recovery finished the corrupt entry's destruction via commit, never a rethrow");
      assert.equal((await stash.tombstones()).length, 0, "the corrupt-entry cleanup writes no grave");
      // And every verb stays live -- no EINTEGRITY poisoning the memoized recover.
      const fresh = await stash.push("healthy");
      assert.ok((await stash.list()).some((e) => e.id === fresh), "the store still accepts and lists new writes");
      await stash.close();
    });
  });
}

// A Stash dropped without draining/closing a pop -- a leaked stream -- can be garbage-
// collected while its guard still holds the claim. When that last holder is collected the
// whole guard entry must go, INCLUDING the stale claim: otherwise a later Stash over the
// same store reuses it and never reclaims the abandoned claim (stuck ECLAIMED). GC-driven,
// so this needs --expose-gc; the memory backend keeps no fd that would pin the leaked
// stream, so its Stash is collectable. Skipped when gc is not exposed.
suite("chaos: guard reclamation on GC", () => {
  test("a Stash GC'd while holding a leaked pop clears its stale guard, so a later Stash reclaims the claim (SPEC.md 6)", { skip: typeof global.gc !== "function", timeout: 15000 }, async () => {
    const CLAIM_TIMEOUT = 40;
    const backend = new MemoryBackend();
    const big = Buffer.alloc(64 * C.BYTES.KIB, 0x70);
    const ref = await (async () => {
      const a = new Stash({ backend, sweepInterval: null, claimTimeout: CLAIM_TIMEOUT });
      const r = await a.push(big);
      const s = await a.pop(r); // claim taken; LEAK the stream -- never drained, never destroyed
      s.on("error", () => {});
      return r; // `a` and `s` fall out of scope -> eligible for collection
    })();
    assert.equal(await backend.isClaimed(ref), true, "the leaked pop left the claim held");

    // Force collection until the guard entry is reaped (the finalizer runs after gc).
    for (let i = 0; i < 100; i += 1) { global.gc(); await new Promise((r) => setImmediate(r)); }

    // A later Stash over the same store: past the lease, its recovery must reclaim the
    // abandoned claim -- the stale guard did not pin it.
    const b = new Stash({ backend, sweepInterval: null, claimTimeout: CLAIM_TIMEOUT });
    await pollUntil(async () => { await b.prune(); return !(await backend.isClaimed(ref)); }, { timeout: 6000 });
    assert.equal(await backend.isClaimed(ref), false, "the abandoned claim from a collected Stash is reclaimable, not pinned");
    await b.close();
  });
});
