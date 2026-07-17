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
  });
}
