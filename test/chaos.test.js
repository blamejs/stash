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

import { Stash } from "../src/index.js";
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
      const big = Buffer.alloc(256 * C.BYTES.KIB, 0x65); // large enough that verify backpressures with no consumer -> genuinely mid-drain
      const liveRef = await setup.push(big);
      const orphanClaim = await inner.claim(orphanRef); // the crashed prior run's abandoned claim
      orphanClaim.source.on("error", () => {});
      orphanClaim.source.destroy(); // close the read handle; the claim file itself remains

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

    test("a claim age-reclaimed DURING acquisition (before its guard is recorded) cannot resurrect a once-only entry for a second reader (SPEC.md 6)", { timeout: 10000 }, async () => {
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
  });
}
