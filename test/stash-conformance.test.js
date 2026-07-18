// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// The backend conformance suite. Every backend runs the same cases through
// the shipped consumer path (new Stash({ backend })); a new backend joins
// by adding a factory to BACKENDS.
import { after, suite, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";

import { Stash, RefNotFound, RefClaimed, InvalidRef, IntegrityError, StashError, SizeExceeded, StashFull } from "../src/index.js";
import { MemoryBackend } from "../src/backends/memory.js";
import { generate } from "../src/ref.js";
import { C } from "../src/constants.js";
import { DIGESTS, digestHash, finalize } from "../src/digest.js";
import { cleanupScratch } from "./_scratch.js";
import {
  SANDBOXED, pollUntil, BACKENDS, drain, makeStoredEntry, syncOnce,
  BACKEND_METHODS, wrapBackend, corruptingReadBackend, retryClaimed,
} from "./_helpers.js";

after(() => cleanupScratch());

// storedEntryUnder(id, bytes, algo, overrides) -- a complete replicated Entry whose
// self-describing digest is computed under `algo` (makeStoredEntry pins sha256). The
// cross-algorithm reconciliation cases need the SAME id + SAME bytes to carry digests
// under DIFFERENT algorithms (a store may hold entries under mixed algorithms, SPEC.md 5).
function storedEntryUnder(id, bytes, algo, overrides = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    ...makeStoredEntry(id, buf, overrides),
    digest: finalize(digestHash(algo).update(buf), algo),
  };
}
for (const { name, create } of BACKENDS) {
  suite("conformance: " + name, () => {
    test("round-trips a Buffer", async () => {
      const stash = new Stash({ backend: create() });
      const payload = Buffer.from([0, 1, 2, 250, 251, 252]);
      const ref = await stash.push(payload);
      assert.match(ref, /^v1_[A-Za-z0-9_-]{43}$/);
      assert.deepEqual(await drain(await stash.apply(ref)), payload);
      // apply is non-destructive: the bytes are still there
      assert.deepEqual(await drain(await stash.apply(ref)), payload);
    });

    test("round-trips a bare Uint8Array without aliasing the caller's buffer", async () => {
      const stash = new Stash({ backend: create() });
      const payload = new Uint8Array([9, 8, 7, 6]);
      const ref = await stash.push(payload);
      payload.fill(0); // caller mutation after push must not reach the store
      assert.deepEqual(await drain(await stash.apply(ref)), Buffer.from([9, 8, 7, 6]));
    });

    test("round-trips a UTF-8 string", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push("hello stash");
      assert.equal((await drain(await stash.apply(ref))).toString("utf8"), "hello stash");
    });

    test("round-trips a Readable without mutating the payload", async () => {
      const stash = new Stash({ backend: create() });
      const payload = Buffer.from("streamed bytes, chunk by chunk");
      const ref = await stash.push(Readable.from([payload.subarray(0, 9), payload.subarray(9)]));
      assert.deepEqual(await drain(await stash.apply(ref)), payload);
    });

    test("round-trips an AsyncIterable", async () => {
      const stash = new Stash({ backend: create() });
      async function* chunks() {
        yield Buffer.from("alpha ");
        yield Buffer.from("beta");
      }
      const ref = await stash.push(chunks());
      assert.equal((await drain(await stash.apply(ref))).toString("utf8"), "alpha beta");
    });

    test("stream chunks are copied at write: caller buffer reuse cannot rewrite stored bytes", async () => {
      // A source that reuses its chunk buffer after the yield -- the pooled
      // slab / scratch-buffer pattern. The store outlives the push, so a
      // retained reference (instead of an owned copy) lets the caller
      // rewrite stored bytes out from under the recorded digest, and the
      // entry dies unreadable on its next apply.
      const stash = new Stash({ backend: create() });
      const scratch = Buffer.from("aaaa");
      async function* reusing() {
        yield scratch;
        scratch.fill(0x62); // runs after the store consumed the first chunk
        yield Buffer.from("cccc");
      }
      const ref = await stash.push(reusing());
      assert.equal((await drain(await stash.apply(ref))).toString("utf8"), "aaaacccc");
    });

    test("round-trips mixed chunk types: string and Uint8Array chunks encode as bytes", async () => {
      const stash = new Stash({ backend: create() });
      async function* chunks() {
        yield "text chunk ";
        yield new Uint8Array([0x62, 0x79, 0x74, 0x65, 0x73]);
      }
      const ref = await stash.push(chunks());
      const got = await drain(await stash.apply(ref));
      assert.equal(got.toString("utf8"), "text chunk bytes");
      assert.equal((await stash.show(ref)).size, got.length);
    });

    test("a zero-byte source round-trips: size 0, digest recorded, bytes empty", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push(Buffer.alloc(0));
      const entry = await stash.show(ref);
      assert.equal(entry.size, 0);
      assert.match(entry.digest, /^sha256:[0-9a-f]{64}$/);
      assert.equal((await drain(await stash.apply(ref))).length, 0);
      const fromString = await stash.push("");
      assert.equal((await stash.show(fromString)).size, 0);
      assert.equal(await stash.drop(ref), true);
    });

    test("an abandoned apply leaves the entry intact and releases its handle", async () => {
      // Destroy the stream after the first chunk: apply is non-destructive,
      // so the entry must survive a partial read, a later apply must drain
      // in full, and drop must succeed immediately -- a read handle left
      // open by the abort would block the delete on Windows.
      const stash = new Stash({ backend: create() });
      const payload = Buffer.alloc(256 * 1024, 7);
      const ref = await stash.push(payload);
      const readable = await stash.apply(ref);
      readable.once("data", () => readable.destroy());
      await new Promise((resolve) => readable.once("close", resolve));
      assert.deepEqual(await drain(await stash.apply(ref)), payload);
      assert.equal(await stash.drop(ref), true);
    });

    test("list accepts includeExpired and rejects unknown options", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push("listed");
      assert.deepEqual((await stash.list({ includeExpired: true })).map((e) => e.id), [ref]);
      assert.deepEqual((await stash.list({ includeExpired: false })).map((e) => e.id), [ref]);
      await assert.rejects(stash.list({ bogus: true }), TypeError);
      await assert.rejects(stash.list(null), TypeError);
    });

    test("push mints a fresh ref per entry, even for identical bytes", async () => {
      const stash = new Stash({ backend: create() });
      const first = await stash.push("same bytes");
      const second = await stash.push("same bytes");
      assert.notEqual(first, second);
      assert.equal((await stash.list()).length, 2);
    });

    test("show returns metadata only, with size and digest computed", async () => {
      const stash = new Stash({ backend: create() });
      const payload = Buffer.from("metadata subject");
      const before = Date.now();
      const ref = await stash.push(payload, { meta: { label: "opaque" } });
      const entry = await stash.show(ref);
      assert.equal(entry.id, ref);
      assert.equal(entry.size, payload.length);
      assert.match(entry.digest, /^sha256:[0-9a-f]{64}$/);
      assert.ok(entry.createdAt >= before && entry.createdAt <= Date.now());
      assert.equal(entry.expiresAt, null);
      assert.equal(entry.reads, null);
      assert.equal(entry.readsLeft, null);
      assert.deepEqual(entry.meta, { label: "opaque" });
      // never contents
      assert.equal("contents" in entry, false);
      assert.equal("chunks" in entry, false);
    });

    test("meta that JSON-serializes to a non-object is refused at push", async () => {
      // meta is stored as its JSON round-trip, and serialization hooks --
      // a Date's toJSON, a caller's own -- can change the value's TYPE
      // between validation and storage. A stored meta that is not a plain
      // object violates the Entry shape the read path enforces: the entry
      // would land unreadable, and any listing that reads it would fail
      // with it. The push must refuse at config time and store nothing.
      const stash = new Stash({ backend: create() });
      for (const meta of [new Date(), { toJSON: () => "flat" }, { toJSON: () => [1] }, { toJSON: () => undefined }]) {
        await assert.rejects(stash.push("x", { meta }), TypeError);
      }
      assert.deepEqual(await stash.list(), []);
      // a non-JSON value nested INSIDE a plain object still round-trips by
      // JSON's own rules -- the top-level object shape is the contract
      const ref = await stash.push("y", { meta: { at: new Date(0) } });
      assert.deepEqual((await stash.show(ref)).meta, { at: "1970-01-01T00:00:00.000Z" });
    });

    test("meta round-trips verbatim as JSON and stays caller-isolated", async () => {
      const stash = new Stash({ backend: create() });
      const meta = { nested: { deep: [1, 2, 3] }, text: "x" };
      const ref = await stash.push("payload", { meta });
      meta.nested.deep.push(4); // caller mutation after push must not leak in
      const entry = await stash.show(ref);
      assert.deepEqual(entry.meta, { nested: { deep: [1, 2, 3] }, text: "x" });
      entry.meta.nested.deep = []; // returned-copy mutation must not leak back
      assert.deepEqual((await stash.show(ref)).meta.nested.deep, [1, 2, 3]);
    });

    test("list enumerates entries; drop removes exactly one", async () => {
      const stash = new Stash({ backend: create() });
      const keep = await stash.push("keep");
      const gone = await stash.push("gone");
      assert.deepEqual((await stash.list()).map((e) => e.id).sort(), [keep, gone].sort());
      assert.equal(await stash.drop(gone), true);
      assert.equal(await stash.drop(gone), false); // absent is a fact, not a failure
      assert.deepEqual((await stash.list()).map((e) => e.id), [keep]);
    });

    test("clear destroys everything and counts it", async () => {
      const stash = new Stash({ backend: create() });
      await stash.push("one");
      await stash.push("two");
      await stash.push("three");
      assert.equal(await stash.clear(), 3);
      assert.deepEqual(await stash.list(), []);
      assert.equal(await stash.clear(), 0);
    });

    test("an unknown well-formed ref is RefNotFound from apply and show", async () => {
      const stash = new Stash({ backend: create() });
      const absent = generate();
      await assert.rejects(stash.apply(absent), (err) => err instanceof RefNotFound && err.code === "ENOREF");
      await assert.rejects(stash.show(absent), (err) => err instanceof RefNotFound && err.code === "ENOREF");
    });

    test("a dropped entry is gone from every read path", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push("ephemeral");
      assert.equal(await stash.drop(ref), true);
      await assert.rejects(stash.apply(ref), RefNotFound);
      await assert.rejects(stash.show(ref), RefNotFound);
      assert.deepEqual(await stash.list(), []);
    });

    // ---- M3 expiry (SPEC.md 7) ------------------------------------------
    // Determinism: ttl:0 makes an entry expired at birth (isExpired's `<=`
    // boundary), so no test sleeps or mocks a clock for the expired cases.

    test("ttl stamps expiresAt = createdAt + ttl, and null ttl leaves it null", async () => {
      const stash = new Stash({ backend: create() });
      const hourly = await stash.show(await stash.push("a", { ttl: "1h" }));
      assert.equal(hourly.expiresAt, hourly.createdAt + 3600000);
      const numeric = await stash.show(await stash.push("b", { ttl: 5000 }));
      assert.equal(numeric.expiresAt, numeric.createdAt + 5000);
      const none = await stash.show(await stash.push("c"));
      assert.equal(none.expiresAt, null);
    });

    test("ttl attaches regardless of source type (Buffer and Readable)", async () => {
      const stash = new Stash({ backend: create() });
      const fromBuf = await stash.show(await stash.push(Buffer.from("buf"), { ttl: "1h" }));
      assert.equal(fromBuf.expiresAt, fromBuf.createdAt + 3600000);
      const fromStream = await stash.show(await stash.push(Readable.from([Buffer.from("stream")]), { ttl: "1h" }));
      assert.equal(fromStream.expiresAt, fromStream.createdAt + 3600000);
    });

    test("the ttl override matrix: absent inherits, explicit overrides, null clears", async () => {
      // constructor default UNSET
      const plain = new Stash({ backend: create() });
      assert.equal((await plain.show(await plain.push("x"))).expiresAt, null);
      assert.notEqual((await plain.show(await plain.push("x", { ttl: "1h" }))).expiresAt, null);
      // constructor default SET -- absent inherits it, explicit (shorter AND
      // longer) overrides it, and ttl:null clears it back to no expiry (the
      // cell a naive `opts.ttl || default` gets wrong)
      const withDefault = new Stash({ backend: create(), ttl: "1h" });
      const inherited = await withDefault.show(await withDefault.push("x"));
      assert.equal(inherited.expiresAt, inherited.createdAt + 3600000);
      const shorter = await withDefault.show(await withDefault.push("x", { ttl: "5m" }));
      assert.equal(shorter.expiresAt, shorter.createdAt + 300000);
      const longer = await withDefault.show(await withDefault.push("x", { ttl: "7d" }));
      assert.equal(longer.expiresAt, longer.createdAt + 604800000);
      assert.equal((await withDefault.show(await withDefault.push("x", { ttl: null }))).expiresAt, null);
    });

    test("an expired entry is RefNotFound from apply, before any sweep runs", async () => {
      const stash = new Stash({ backend: create() }); // NO sweepInterval
      const ref = await stash.push("gone at birth", { ttl: 0 });
      await assert.rejects(stash.apply(ref), (err) => err instanceof RefNotFound && err.code === "ENOREF");
    });

    test("an expired entry is RefNotFound from show", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push("gone at birth", { ttl: 0 });
      await assert.rejects(stash.show(ref), (err) => err instanceof RefNotFound && err.code === "ENOREF");
    });

    test("the lazy read path drops the entry in passing, not merely hides it", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push("x", { ttl: 0 });
      await assert.rejects(stash.apply(ref), RefNotFound);
      // includeExpired would still show a merely-hidden entry; it is EMPTY, so
      // the lazy path removed it.
      assert.deepEqual(await stash.list({ includeExpired: true }), []);
    });

    test("list filters expired by default but never drops; includeExpired shows them", async () => {
      const stash = new Stash({ backend: create() });
      const live = await stash.push("live", { ttl: "1h" });
      await stash.push("dead", { ttl: 0 });
      assert.deepEqual((await stash.list()).map((e) => e.id), [live]);
      assert.equal((await stash.list({ includeExpired: true })).length, 2);
      // calling list() again did not drop the expired entry -- no read verb ran
      assert.equal((await stash.list({ includeExpired: true })).length, 2);
    });

    test("list rejects a non-boolean includeExpired instead of leaking expired entries", async () => {
      const stash = new Stash({ backend: create() });
      const live = await stash.push("live", { ttl: "1h" });
      await stash.push("dead", { ttl: 0 });
      // a truthy non-boolean (e.g. the string "false" from a config parse) must
      // NOT expose the expired entry the default hides
      for (const bad of ["false", "true", 1, 0, {}, []]) {
        await assert.rejects(stash.list({ includeExpired: bad }), (err) => err instanceof TypeError && !(err instanceof StashError));
      }
      // the booleans still work
      assert.deepEqual((await stash.list({ includeExpired: false })).map((e) => e.id), [live]);
      assert.equal((await stash.list({ includeExpired: true })).length, 2);
    });

    test("prune destroys expired only and returns the real count", async () => {
      const stash = new Stash({ backend: create() });
      await stash.push("dead1", { ttl: 0 });
      await stash.push("dead2", { ttl: 0 });
      const live = await stash.push("live", { ttl: "1h" });
      assert.equal(await stash.prune(), 2);
      assert.equal(await stash.prune(), 0);
      // the live entry survived every read path
      assert.equal((await stash.show(live)).id, live);
      assert.equal((await stash.list({ includeExpired: true })).length, 1);
    });

    test("apply opens no read stream on an expired entry: zero reads, one remove", async () => {
      const inner = create();
      const calls = [];
      const backend = {};
      for (const m of BACKEND_METHODS) {
        backend[m] = (...args) => { calls.push(m); return inner[m](...args); };
      }
      const stash = new Stash({ backend });
      await stash.push("x", { ttl: 0 });
      calls.length = 0; // ignore the push's calls
      await assert.rejects(stash.apply(await inner.list().then((es) => es[0].id)), RefNotFound);
      assert.equal(calls.filter((c) => c === "read").length, 0, "no read on an expired entry");
      assert.equal(calls.filter((c) => c === "remove").length, 1, "dropped in passing exactly once");
    });

    test("apply re-checks expiry after opening the read: an entry lapsing in the open window is dropped, not served", async () => {
      // The gate and the open are two awaits apart; an entry alive at the gate
      // can lapse before the stream is handed out. A backend whose read() is
      // delayed past the deadline reproduces it deterministically.
      const inner = create();
      let readCalled = false;
      const backend = {
        ...wrapBackend(inner),
        read: async (id) => {
          readCalled = true;
          const e = await inner.stat(id);
          while (Date.now() < e.expiresAt) await new Promise((r) => setTimeout(r, 2)); // poll, don't sleep
          return inner.read(id);
        },
      };
      const stash = new Stash({ backend });
      const ref = await stash.push("secret bytes", { ttl: 150 }); // alive at the gate; expires during the delayed open
      await assert.rejects(stash.apply(ref), (err) => err instanceof RefNotFound && err.code === "ENOREF");
      assert.equal(readCalled, true, "the read WAS opened -- the reject came from the post-open re-check, not the pre-gate");
      assert.deepEqual(await stash.list({ includeExpired: true }), []); // dropped in passing, source disposed
    });

    test("apply's serve-time expiry reap emits 'expired' exactly once (SPEC.md 4.3), like the gate and the budgeted path", async () => {
      // The same stat->read lapse window, but asserting the AUDIT trail: an entry
      // reaped by the post-open re-check must fire 'expired' once -- every OTHER
      // reap path (#statLive, #claimedRead) emits, so this lazy-read path cannot
      // be the one that destroys an entry silently.
      const inner = create();
      const backend = {
        ...wrapBackend(inner),
        read: async (id) => {
          const e = await inner.stat(id);
          while (Date.now() < e.expiresAt) await new Promise((r) => setTimeout(r, 2)); // poll, don't sleep
          return inner.read(id);
        },
      };
      const stash = new Stash({ backend });
      const seen = [];
      stash.on("expired", (e) => seen.push(e));
      const ref = await stash.push("secret bytes", { ttl: 150 }); // alive at the gate; expires in the delayed open
      await assert.rejects(stash.apply(ref), (err) => err instanceof RefNotFound && err.code === "ENOREF");
      assert.equal(seen.length, 1, "the serve-time reap emitted 'expired' exactly once");
      assert.equal(seen[0].id, ref, "the payload is the reaped entry");
    });

    test("apply's expiry re-check tolerates an already-closed read source: still drops, no leak", async () => {
      // The dispose helper guards a source that is null, not a stream, or
      // already destroyed -- a backend can legitimately hand one back. Drive
      // that branch: a lapsing entry whose read() returns an already-destroyed
      // stream still drops and rejects, without re-destroying or hanging.
      const inner = create();
      const backend = {
        ...wrapBackend(inner),
        read: async (id) => {
          const e = await inner.stat(id);
          while (Date.now() < e.expiresAt) await new Promise((r) => setTimeout(r, 2));
          const s = await inner.read(id);
          s.destroy(); // hand back an already-closed source
          return s;
        },
      };
      const stash = new Stash({ backend });
      const ref = await stash.push("x", { ttl: 100 });
      await assert.rejects(stash.apply(ref), (err) => err instanceof RefNotFound && err.code === "ENOREF");
      assert.deepEqual(await stash.list({ includeExpired: true }), []);
    });

    test("apply's expiry re-check does not hang on a non-closing source (emitClose:false)", { timeout: 8000 }, async () => {
      // A Readable with emitClose:false emits neither 'close' nor 'error' on
      // destroy -- the SPEC.md 9 contract only promises a Readable. Disposal
      // must not wait on a close event, or apply would hang forever and never
      // reject / remove.
      const inner = create();
      const backend = {
        ...wrapBackend(inner),
        read: async (id) => {
          const e = await inner.stat(id);
          while (Date.now() < e.expiresAt) await new Promise((r) => setTimeout(r, 2));
          return new Readable({ read() {}, emitClose: false });
        },
      };
      const stash = new Stash({ backend });
      const ref = await stash.push("x", { ttl: 100 });
      await assert.rejects(stash.apply(ref), (err) => err instanceof RefNotFound && err.code === "ENOREF");
      assert.deepEqual(await stash.list({ includeExpired: true }), []);
    });

    test("apply's expiry re-check disposes a source that errors on teardown, without hanging", async () => {
      // The dispose helper resolves on the source's 'close' OR 'error' -- a
      // teardown that errors must not leave apply hung. Drive the error arm: a
      // lapsing entry whose read() returns a stream that errors when destroyed.
      const inner = create();
      const backend = {
        ...wrapBackend(inner),
        read: async (id) => {
          const e = await inner.stat(id);
          while (Date.now() < e.expiresAt) await new Promise((r) => setTimeout(r, 2));
          return new Readable({ read() {}, destroy(_err, cb) { cb(new Error("teardown boom")); } });
        },
      };
      const stash = new Stash({ backend });
      const ref = await stash.push("x", { ttl: 100 });
      await assert.rejects(stash.apply(ref), (err) => err instanceof RefNotFound && err.code === "ENOREF");
      assert.deepEqual(await stash.list({ includeExpired: true }), []);
    });

    test("a ttl whose expiresAt sum is not a safe integer is refused at push, storing nothing", async () => {
      const stash = new Stash({ backend: create() });
      await assert.rejects(stash.push("x", { ttl: Number.MAX_SAFE_INTEGER }), TypeError);
      assert.deepEqual(await stash.list({ includeExpired: true }), []);
    });

    test("hostile ttl values are config-time TypeErrors and store nothing", async () => {
      const stash = new Stash({ backend: create() });
      for (const ttl of [-1, NaN, Infinity, "abc", "5w", "1H", 1500.5, true, {}]) {
        await assert.rejects(stash.push("x", { ttl }), (err) => err instanceof TypeError && !(err instanceof StashError));
      }
      assert.deepEqual(await stash.list({ includeExpired: true }), []);
      // the same battery rejected as a constructor default
      for (const ttl of [-1, NaN, Infinity, "abc", "5w", "1H", 1500.5, true, {}]) {
        assert.throws(() => new Stash({ backend: create(), ttl }), TypeError);
      }
    });

    // ---- M4 limits (SPEC.md 8) ------------------------------------------

    test("maxSize: exactly the limit round-trips; one byte over is SizeExceeded", async () => {
      const stash = new Stash({ backend: create(), maxSize: 16 });
      const ref = await stash.push(Buffer.alloc(16, 7));
      assert.equal((await drain(await stash.apply(ref))).length, 16);
      await assert.rejects(stash.push(Buffer.alloc(17, 7)), (e) => e instanceof SizeExceeded && e.code === "E2BIG");
    });

    test("maxSize is enforced mid-stream: no chunk after the crossing one is pulled", async () => {
      const stash = new Stash({ backend: create(), maxSize: 10 });
      const pulled = [];
      async function* chunks() {
        for (let i = 0; i < 5; i++) { pulled.push(i); yield Buffer.alloc(4, i); } // 4,8,12 crosses at the third
      }
      await assert.rejects(stash.push(chunks()), SizeExceeded);
      assert.ok(pulled.length <= 3, "stopped at the crossing chunk, not drained (pulled " + pulled.length + ")");
    });

    test("a single oversized chunk is rejected before it is copied into memory", async () => {
      // The chunk's byte length must be checked before Buffer.from duplicates
      // it, or a small maxSize can still be driven to OOM by one hostile chunk.
      // A Proxy whose length is huge but whose data throws on access proves the
      // copy never ran: if it had, reading index 0 would throw a different error.
      const stash = new Stash({ backend: create(), maxSize: 16 });
      const hostile = new Proxy({ length: 1e9 }, {
        get(_target, prop) {
          if (prop === "length") return 1e9;
          // `then` and symbols are probed by `for await` and Buffer.from's type
          // checks -- leave those; only a numeric-index read means the copy ran.
          if (prop === "then" || typeof prop === "symbol") return undefined;
          throw new Error("chunk data was read -- the copy ran before the size check");
        },
      });
      async function* one() { yield hostile; }
      await assert.rejects(stash.push(one()), (e) => e instanceof SizeExceeded);
    });

    test("maxSize bounds an ArrayBuffer chunk: no .length is not a bypass", async () => {
      // An ArrayBuffer has no `.length`, so measuring it as chunk.length yields
      // undefined and the running total goes NaN -- every comparison false -- and
      // an oversized ArrayBuffer slips past maxSize entirely. It must be measured
      // by byteLength.
      const stash = new Stash({ backend: create(), maxSize: 16 });
      async function* one() { yield new ArrayBuffer(64); } // 4x maxSize
      await assert.rejects(stash.push(one()), (e) => e instanceof SizeExceeded && e.code === "E2BIG");
    });

    test("maxSize bounds a SharedArrayBuffer chunk the same as an ArrayBuffer", async () => {
      // A SharedArrayBuffer is not `instanceof ArrayBuffer`, so a bare instanceof
      // check misses it and its bytes go unmeasured (chunk.length is undefined),
      // yet Buffer.from stores every byte -- the bytes counted must be the bytes
      // written. A realm-proof brand check measures it by byteLength.
      const stash = new Stash({ backend: create(), maxSize: 16 });
      async function* one() { yield new SharedArrayBuffer(64); } // 4x maxSize
      await assert.rejects(stash.push(one()), (e) => e instanceof SizeExceeded && e.code === "E2BIG");
    });

    test("maxSize measures a typed array by its bytes, not its element count", async () => {
      // A Uint16Array's `.length` is its element count; its byte size is twice
      // that. Measuring by `.length` lets a 128-byte view slip past a 100-byte
      // maxSize -- the byte length is what fills the store.
      const stash = new Stash({ backend: create(), maxSize: 100 });
      async function* one() { yield new Uint16Array(64); } // 64 elements = 128 bytes
      await assert.rejects(stash.push(one()), (e) => e instanceof SizeExceeded && e.code === "E2BIG");
    });

    test("a typed-array chunk is stored by its exact bytes, not reinterpreted element-wise", async () => {
      // Buffer.from(uint16array) copies element VALUES (each mod 256), losing the
      // high byte of every element. The chunk must be normalized over its own
      // bytes so a multi-byte view round-trips intact.
      const stash = new Stash({ backend: create() });
      const view = new Uint16Array([0x0102, 0x0304]); // 4 bytes in memory order
      async function* one() { yield view; }
      const ref = await stash.push(one());
      const out = await drain(await stash.apply(ref));
      assert.deepEqual(out, Buffer.from(view.buffer, view.byteOffset, view.byteLength));
    });

    test("an unbounded source is abandoned at the boundary, not drained", async () => {
      const stash = new Stash({ backend: create(), maxSize: 64 });
      let finallyRan = false;
      let yielded = 0;
      async function* infinite() {
        try { for (;;) { yielded += 1; yield Buffer.alloc(8, 1); } } finally { finallyRan = true; }
      }
      await assert.rejects(stash.push(infinite()), SizeExceeded);
      assert.equal(finallyRan, true, "the source's finally ran -- early termination reached it");
      assert.ok(yielded <= 9, "pulls bounded by ~ceil(maxSize/chunk), not infinite (" + yielded + ")");
    });

    test("every source type over maxSize gets SizeExceeded", async () => {
      const big = Buffer.alloc(20, 3);
      const sources = [big, new Uint8Array(big), "x".repeat(20), Readable.from([big]), (async function* () { yield big; })()];
      for (const src of sources) {
        await assert.rejects(new Stash({ backend: create(), maxSize: 10 }).push(src), SizeExceeded);
      }
    });

    test("maxSize counts UTF-8 bytes, not string length", async () => {
      const stash = new Stash({ backend: create(), maxSize: 3 });
      await assert.rejects(stash.push("\u00e9\u00e9"), SizeExceeded); // U+00E9 x2: 2 chars, 4 UTF-8 bytes
      assert.match(await stash.push("abc"), /^v1_/); // 3 bytes fits exactly
    });

    test("a refused push leaves no poisoned state; a later legitimate push works", async () => {
      const stash = new Stash({ backend: create(), maxSize: 8 });
      await assert.rejects(stash.push(Buffer.alloc(9, 1)), SizeExceeded);
      assert.deepEqual(await stash.list(), []);
      const ref = await stash.push(Buffer.alloc(8, 1));
      assert.equal((await stash.list()).length, 1);
      assert.equal((await drain(await stash.apply(ref))).length, 8);
    });

    test("maxEntries: a full store is StashFull before the stream starts; drop frees a slot", async () => {
      const inner = create();
      const backend = {};
      for (const m of BACKEND_METHODS) backend[m] = (...a) => inner[m](...a);
      const stash = new Stash({ backend, maxEntries: 1 });
      const first = await stash.push("a");
      let pulled = false;
      async function* watched() { pulled = true; yield Buffer.from("b"); }
      await assert.rejects(stash.push(watched()), (e) => e instanceof StashFull && e.code === "EFULL");
      assert.equal(pulled, false, "rejected before the source was pulled -- no eviction, no wasted read");
      await stash.drop(first);
      assert.match(await stash.push("b"), /^v1_/);
    });

    test("maxTotal: a push whose footprint exceeds the remaining headroom is StashFull; the partial is cleaned; a fitting re-push works", async () => {
      // maxTotal bounds the stored footprint (blob + sidecar), so size it from a
      // measured entry rather than a bare blob-byte count. Room for two such
      // entries leaves headroom for a second small blob but not a large one.
      const gauge = create();
      await new Stash({ backend: gauge }).push(Buffer.alloc(10, 1));
      const oneEntry = (await gauge.stats()).bytes; // one 10-byte-blob entry: blob plus sidecar
      const stash = new Stash({ backend: create(), maxTotal: 2 * oneEntry });
      await stash.push(Buffer.alloc(10, 1)); // the first entry lands
      // a blob as large as a whole entry cannot fit beside the first plus a new sidecar
      await assert.rejects(stash.push(Buffer.alloc(oneEntry, 2)), (e) => e instanceof StashFull && e.code === "EFULL");
      assert.equal((await stash.list()).length, 1); // the over-budget push left no partial
      assert.match(await stash.push(Buffer.alloc(4, 2)), /^v1_/); // a small blob still fits the headroom
    });

    test("maxTotal boundary: an entry filling the limit lands; any further push -- even zero-byte -- rejects", async () => {
      // A zero-byte blob is not free: it still carries a sidecar. So at the limit
      // even an empty push rejects, because its sidecar alone no longer fits.
      const gauge = create();
      await new Stash({ backend: gauge }).push(Buffer.alloc(10, 1));
      const oneEntry = (await gauge.stats()).bytes;
      const stash = new Stash({ backend: create(), maxTotal: oneEntry }); // room for exactly one
      await stash.push(Buffer.alloc(10, 1)); // fills the store to the limit
      await assert.rejects(stash.push(Buffer.alloc(0)), StashFull); // a zero-byte blob still needs a sidecar
      await assert.rejects(stash.push(Buffer.alloc(1, 2)), StashFull);
      assert.equal((await stash.list()).length, 1);
    });

    test("with both bounds set, a per-entry overflow reports SizeExceeded, not StashFull", async () => {
      // maxSize is the per-entry cap, maxTotal the whole-store cap. A blob over
      // maxSize reports the permanent verdict (SizeExceeded) -- a retry can't shrink
      // the entry -- rather than the transient StashFull, since _boundedSource
      // checks the per-entry bound before the stash-wide residual on each chunk.
      const stash = new Stash({ backend: create(), maxSize: 4, maxTotal: "1gb" });
      await assert.rejects(stash.push(Buffer.alloc(5, 2)), (e) => e instanceof SizeExceeded && e.code === "E2BIG");
    });

    test("maxTotal counts the entry's own metadata: a tiny blob with a large meta is StashFull, not a bypass", async () => {
      // stats().bytes counts blob + sidecar, and the sidecar serializes meta. If
      // the pre-check bounded only the blob, a caller could push unbounded metadata
      // under maxTotal by keeping the blob tiny. The entry's own sidecar counts
      // against the headroom, so an oversized meta is refused before it lands.
      const stash = new Stash({ backend: create(), maxTotal: 400 });
      await assert.rejects(
        stash.push(Buffer.alloc(1, 1), { meta: { big: "a".repeat(2000) } }),
        (e) => e instanceof StashFull && e.code === "EFULL",
      );
      assert.deepEqual(await stash.list(), []); // nothing landed
    });

    test("maxTotal counts every entry's sidecar: repeated zero-byte pushes cannot grow the store without bound", async () => {
      // A zero-byte blob still costs a sidecar. Once the footprint reaches maxTotal
      // even an empty push is refused -- the sidecar alone no longer fits -- so a
      // loop of zero-byte pushes can't creep past the limit one sidecar at a time.
      const stash = new Stash({ backend: create(), maxTotal: 600 });
      let stored = 0;
      for (let i = 0; i < 50; i += 1) {
        try {
          await stash.push(Buffer.alloc(0));
          stored += 1;
        } catch (e) {
          assert.ok(e instanceof StashFull);
          break;
        }
      }
      assert.ok(stored >= 1, "at least one zero-byte entry fits");
      assert.ok(stored < 50, "the store fills and rejects rather than admitting all 50");
    });

    test("an unlimited stash never reads backend.stats()", async () => {
      const inner = create();
      let statsCalls = 0;
      const backend = {};
      for (const m of BACKEND_METHODS) backend[m] = (...a) => inner[m](...a);
      backend.stats = (...a) => { statsCalls += 1; return inner.stats(...a); };
      const stash = new Stash({ backend });
      await stash.push(Buffer.alloc(65536, 1));
      assert.equal(statsCalls, 0, "the common path pays nothing for the feature");
    });

    test("expired-but-unswept entries do not hold the door shut (maxEntries and maxTotal)", async () => {
      const s1 = new Stash({ backend: create(), maxEntries: 1 });
      await s1.push("dead", { ttl: 0 }); // expired at birth
      const live1 = await s1.push("live"); // the pre-check prunes the dead one, then admits this
      assert.equal((await s1.show(live1)).id, live1);
      assert.deepEqual((await s1.list({ includeExpired: true })).map((e) => e.id), [live1]);

      const gauge = create();
      await new Stash({ backend: gauge }).push(Buffer.alloc(12, 9));
      const oneEntry = (await gauge.stats()).bytes; // one 12-byte-blob entry: blob plus sidecar
      const s2 = new Stash({ backend: create(), maxTotal: oneEntry }); // room for exactly one
      await s2.push(Buffer.alloc(12, 9), { ttl: 0 }); // fat and expired, fills the store
      const live2 = await s2.push(Buffer.alloc(12, 1)); // fits only once the dead one is reaped
      assert.equal((await s2.show(live2)).id, live2);
    });

    test("maxTotal: an expired entry in the sidecar band does not block a live push", async () => {
      // The rejection threshold with the sidecar charged is maxTotal - sidecar,
      // BELOW maxTotal. If the prune only fires at stats.bytes >= maxTotal, a dead
      // entry that leaves the footprint in the band (maxTotal - sidecar, maxTotal)
      // is never reaped, and a live push is wrongly refused. Expired entries must
      // be reclaimed before the headroom is judged.
      const gauge = create();
      await new Stash({ backend: gauge }).push(Buffer.alloc(8, 1), { ttl: 0 });
      const oneDead = (await gauge.stats()).bytes; // a dead 8-byte entry's footprint
      const stash = new Stash({ backend: create(), maxTotal: oneDead + 1 });
      await stash.push(Buffer.alloc(8, 1), { ttl: 0 }); // fills to oneDead: inside the band
      const live = await stash.push(Buffer.alloc(8, 2)); // must reap the dead one first
      assert.equal((await stash.show(live)).id, live);
      assert.deepEqual((await stash.list({ includeExpired: true })).map((e) => e.id), [live]);
    });

    test("StashFull/SizeExceeded are StashErrors; a bad limit value is a config TypeError, not a StashError", async () => {
      const stash = new Stash({ backend: create(), maxSize: 4 });
      await assert.rejects(stash.push(Buffer.alloc(5, 1)), (e) => e instanceof StashError);
      assert.throws(() => new Stash({ backend: create(), maxSize: "nope" }), (e) => e instanceof TypeError && !(e instanceof StashError));
    });

    // ---- M5: pop and read budgets (SPEC.md 4, 4.1, 6) --------------------------

    test("pop round-trips and destroys: the payload streams once, then the entry is gone", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push("bytes at rest");
      assert.deepEqual(await drain(await stash.pop(ref)), Buffer.from("bytes at rest"));
      await assert.rejects(stash.show(ref), (e) => e instanceof RefNotFound && e.code === "ENOREF");
      await assert.rejects(stash.apply(ref), RefNotFound);
      await assert.rejects(stash.pop(ref), RefNotFound);
      assert.deepEqual(await stash.list(), []);
    });

    test("pop ignores the read budget: one drain destroys a reads:3 entry", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push("terminal", { reads: 3 });
      assert.deepEqual(await drain(await stash.pop(ref)), Buffer.from("terminal"));
      await assert.rejects(stash.show(ref), RefNotFound); // pop is terminal, budget notwithstanding
    });

    test("concurrent pop: exactly one drains the payload, the other is RefClaimed", async () => {
      const stash = new Stash({ backend: create() });
      // A payload above the stream highWaterMark: the winner's claim stays held
      // (backpressure) until it is drained, so the loser's claim genuinely races
      // a live claim rather than a payload that already auto-committed.
      const payload = Buffer.alloc(65536, 7);
      const ref = await stash.push(payload);
      const settled = await Promise.allSettled([stash.pop(ref), stash.pop(ref)]);
      const winners = settled.filter((r) => r.status === "fulfilled");
      const losers = settled.filter((r) => r.status === "rejected");
      assert.equal(winners.length, 1, "exactly one pop won the claim");
      assert.equal(losers.length, 1);
      assert.equal(losers[0].reason.code, "ECLAIMED");
      assert.deepEqual(await drain(winners[0].value), payload);
      await assert.rejects(stash.show(ref), RefNotFound);
    });

    test("pop destroyed mid-stream restores under the default policy; a retry drains fully", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push(Buffer.alloc(65536, 7));
      const partial = await stash.pop(ref);
      partial.destroy(); // abandon -- the claim resolves to restore in the background
      // the restore is not instantaneous, so a retried pop loses the claim until
      // it lands (RefClaimed) -- the real caller pattern; retry until it drains.
      const retried = await retryClaimed(async () => drain(await stash.pop(ref)));
      assert.deepEqual(retried, Buffer.alloc(65536, 7)); // survived the abandon
    });

    test("pop destroyed mid-stream under onPopFailure: 'burn' destroys the entry", async () => {
      const stash = new Stash({ backend: create(), onPopFailure: "burn" });
      const ref = await stash.push(Buffer.alloc(65536, 7));
      const partial = await stash.pop(ref);
      partial.destroy();
      await pollUntil(async () => { try { await stash.show(ref); return false; } catch { return true; } });
      await assert.rejects(stash.show(ref), RefNotFound); // burned
    });

    test("a corrupted pop errors IntegrityError; under 'restore' the entry survives", async () => {
      const inner = create();
      const backend = wrapBackend(inner, {
        claim: async (id) => {
          const c = await inner.claim(id);
          c.source.destroy();
          return { entry: c.entry, source: Readable.from([Buffer.from("tampered")]) };
        },
      });
      const stash = new Stash({ backend });
      const ref = await stash.push("original");
      await assert.rejects(drain(await stash.pop(ref)), (e) => e instanceof IntegrityError && e.code === "EINTEGRITY");
      assert.equal((await stash.show(ref)).id, ref); // restored, not lost
    });

    test("reads:2 sequential: two full drains, readsLeft:1 between, then RefNotFound", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push("twice", { reads: 2 });
      assert.deepEqual(await drain(await stash.apply(ref)), Buffer.from("twice"));
      assert.equal((await stash.show(ref)).readsLeft, 1);
      assert.deepEqual(await drain(await stash.apply(ref)), Buffer.from("twice"));
      await assert.rejects(stash.show(ref), RefNotFound);
      await assert.rejects(stash.apply(ref), RefNotFound);
    });

    test("reads:2 concurrent: exactly two drained successes ever, then RefNotFound", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push("shared", { reads: 2 });
      let drained = 0;
      // race more readers than credits; losers retry the claim until it is exhausted
      await Promise.all(Array.from({ length: 6 }, () => (async () => {
        try {
          const bytes = await retryClaimed(async () => drain(await stash.apply(ref)));
          assert.deepEqual(bytes, Buffer.from("shared"));
          drained += 1;
        } catch (err) {
          if (!(err instanceof RefNotFound)) throw err; // the budget is spent -- expected
        }
      })()));
      assert.equal(drained, 2, "a reads:2 entry served exactly twice under contention");
      await assert.rejects(stash.show(ref), RefNotFound);
    });

    test("a budgeted read serializes: the loser rejects at claim time, it does not queue", async () => {
      const stash = new Stash({ backend: create() });
      const payload = Buffer.alloc(65536, 1);
      const ref = await stash.push(payload, { reads: 1 });
      // both applies race for the single credit; the winner holds the claim
      // (large payload, backpressure) so the loser rejects RefClaimed at claim
      // time rather than queueing behind the winner.
      const settled = await Promise.allSettled([stash.apply(ref), stash.apply(ref)]);
      const winners = settled.filter((r) => r.status === "fulfilled");
      const losers = settled.filter((r) => r.status === "rejected");
      assert.equal(winners.length, 1, "one reader won the single credit");
      assert.equal(losers[0].reason.code, "ECLAIMED");
      assert.deepEqual(await drain(winners[0].value), payload);
      await assert.rejects(stash.show(ref), RefNotFound); // the one credit is spent
    });

    test("an abandoned budgeted read spends nothing: readsLeft is unchanged, monotone", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push(Buffer.alloc(65536, 1), { reads: 2 });
      const partial = await stash.apply(ref);
      partial.destroy(); // abandon -- the claim restores in the background, no spend
      // retry the next read past the in-flight restore (RefClaimed), then confirm
      // the budget was never debited: the abandoned read cost nothing.
      const bytes = await retryClaimed(async () => drain(await stash.apply(ref)));
      assert.deepEqual(bytes, Buffer.alloc(65536, 1)); // still readable
      // that retried read spent one of two credits; the abandoned one spent none
      assert.equal((await stash.show(ref)).readsLeft, 1, "only the completed read debited -- the abandon cost nothing");
    });

    test("a failed budgeted read (digest mismatch) errors IntegrityError and spends nothing", async () => {
      const inner = create();
      const backend = wrapBackend(inner, {
        claim: async (id) => {
          const c = await inner.claim(id);
          c.source.destroy();
          return { entry: c.entry, source: Readable.from([Buffer.from("tampered")]) };
        },
      });
      const stash = new Stash({ backend });
      const ref = await stash.push("original", { reads: 2 });
      await assert.rejects(drain(await stash.apply(ref)), IntegrityError);
      assert.equal((await stash.show(ref)).readsLeft, 2, "a failed drain is not a spend -- drain AND digest match is");
    });

    test("an unbudgeted apply stays lock-free: it takes no claim", async () => {
      const inner = create();
      const seen = [];
      const backend = wrapBackend(inner, {
        claim: (...a) => { seen.push("claim"); return inner.claim(...a); },
        restore: (...a) => { seen.push("restore"); return inner.restore(...a); },
        commit: (...a) => { seen.push("commit"); return inner.commit(...a); },
        consumeRead: (...a) => { seen.push("consumeRead"); return inner.consumeRead(...a); },
      });
      const stash = new Stash({ backend });
      const ref = await stash.push("unbudgeted");
      await drain(await stash.apply(ref));
      assert.deepEqual(seen, [], "no claim machinery ran for an unbudgeted apply");
    });

    test("the terminal budgeted read destroys through the commit path", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push("last", { reads: 1 });
      assert.deepEqual(await drain(await stash.apply(ref)), Buffer.from("last"));
      await assert.rejects(stash.show(ref), RefNotFound);
      await assert.rejects(stash.apply(ref), RefNotFound);
      assert.deepEqual(await stash.list(), []);
    });

    test("a claimed entry is RefClaimed to a concurrent reader, not IntegrityError", async () => {
      const stash = new Stash({ backend: create() });
      const payload = Buffer.alloc(65536, 3); // above the highWaterMark: the claim stays held
      const ref = await stash.push(payload);
      const inflight = await stash.pop(ref); // claimed, not yet drained
      await assert.rejects(stash.apply(ref), (e) => e instanceof RefClaimed && e.code === "ECLAIMED");
      await assert.rejects(stash.pop(ref), RefClaimed);
      await drain(inflight); // finish the pop
      await assert.rejects(stash.show(ref), RefNotFound);
    });

    test("pop and budgeted apply on an expired entry are RefNotFound with no claim taken", async () => {
      const inner = create();
      const seen = [];
      const backend = wrapBackend(inner, { claim: (...a) => { seen.push("claim"); return inner.claim(...a); } });
      const stash = new Stash({ backend });
      const popRef = await stash.push("gone", { ttl: 0 });
      await assert.rejects(stash.pop(popRef), RefNotFound);
      const applyRef = await stash.push("gone2", { ttl: 0, reads: 2 });
      await assert.rejects(stash.apply(applyRef), RefNotFound);
      assert.deepEqual(seen, [], "an expired entry is rejected before any claim");
    });

    test("a drop during a live claim is monotone: the entry never serves again, and the abandon spends nothing", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push(Buffer.alloc(65536, 7), { reads: 2 }); // above the highWaterMark: the claim holds
      const held = await stash.apply(ref); // a budgeted read takes the claim
      await stash.drop(ref); // destroy the entry mid-claim (SPEC 4.2 monotone)
      await assert.rejects(stash.show(ref), RefNotFound, "a dropped entry is gone, even while claimed");
      held.destroy(); // abandon the read -- its onFail restore must NOT resurrect the dropped entry
      // retry past any in-flight restore (RefClaimed), then confirm the entry stays gone
      await assert.rejects(retryClaimed(() => stash.apply(ref)), RefNotFound);
    });

    // ---- M6: audit surface (has / stats / verify) + the event set (SPEC.md 4, 4.3) ----
    test("has: true for a live entry, false for an unknown ref, InvalidRef for a hostile one", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push("here");
      assert.equal(await stash.has(ref), true);
      assert.equal(await stash.has(generate()), false); // well-formed but absent
      for (const hostile of ["v1_../../etc", "../secret", "v1_short", "not-a-ref"]) {
        await assert.rejects(stash.has(hostile), InvalidRef); // whitelist before any backend touch
      }
    });

    test("has: an expired entry is false, reaped in passing, emitting 'expired' exactly once", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push("gone", { ttl: 0 }); // expired at push time
      const seen = [];
      stash.on("expired", (e) => seen.push(e.id));
      assert.equal(await stash.has(ref), false);
      assert.equal(await stash.has(ref), false); // already reaped -> still false, no second emit
      assert.deepEqual(seen, [ref], "reaped once, one 'expired'");
    });

    test("stats: aggregates only, exactly { entries, bytes, claimed }, never refs", async () => {
      const stash = new Stash({ backend: create() });
      assert.deepEqual(await stash.stats(), { entries: 0, bytes: 0, claimed: 0 });
      await stash.push(Buffer.alloc(100, 1));
      await stash.push(Buffer.alloc(50, 2));
      const s = await stash.stats();
      assert.deepEqual(Object.keys(s).sort(), ["bytes", "claimed", "entries"]);
      assert.equal(s.entries, 2);
      assert.ok(s.bytes >= 150, "counts both blobs plus their metadata");
      assert.equal(JSON.stringify(s).includes("v1_"), false, "no ref leaks into stats");
    });

    test("stats.claimed counts a live in-flight pop claim, back to 0 after the drain", async () => {
      const stash = new Stash({ backend: create() });
      const ref = await stash.push(Buffer.alloc(65536, 9)); // above the highWaterMark: the claim holds un-drained
      const held = await stash.pop(ref);
      assert.equal((await stash.stats()).claimed, 1);
      await drain(held);
      assert.equal((await stash.stats()).claimed, 0);
    });

    test("verify: a clean store reports no findings; bad opts are config-time TypeErrors", async () => {
      const stash = new Stash({ backend: create() });
      await stash.push("a");
      await stash.push("b");
      const report = await stash.verify();
      assert.deepEqual(Object.keys(report).sort(), ["findings", "repaired", "scanned"]);
      assert.equal(report.scanned, 2);
      assert.deepEqual(report.findings, []);
      assert.deepEqual(report.repaired, []);
      await assert.rejects(stash.verify({ nope: 1 }), TypeError);
      await assert.rejects(stash.verify({ repair: "yes" }), TypeError);
      await assert.rejects(stash.verify(null), TypeError);
    });

    test("verify().scanned counts a claimed entry, matching stats().entries on every backend (parity)", async () => {
      // A claimed entry (mid-pop) still occupies the store: disk keeps its sidecar
      // in meta/, memory holds it in #claims. Both must count it in `scanned`, or
      // the shared-contract report diverges across backends for one logical store.
      const stash = new Stash({ backend: create() });
      await stash.push("live");
      const ref = await stash.push(Buffer.alloc(65536, 4)); // above the highWaterMark: the claim holds un-drained
      const held = await stash.pop(ref); // claimed, not yet drained -> mid-pop
      try {
        const s = await stash.stats();
        const v = await stash.verify();
        assert.equal(s.claimed, 1, "one entry is mid-pop");
        assert.equal(v.scanned, s.entries, "verify scans every entry stats counts -- claimed included");
        assert.equal(v.scanned, 2, "both the live and the claimed entry are scanned");
      } finally {
        await drain(held); // release the claim so cleanup is clean
      }
    });

    test("'pushed' fires after commit with a full defensive-copy Entry; 'dropped' fires per drop and per clear", async () => {
      const stash = new Stash({ backend: create() });
      const pushed = [];
      stash.on("pushed", (e) => pushed.push(e));
      const ref = await stash.push("x", { meta: { k: 1 } });
      assert.equal(pushed.length, 1);
      assert.equal(pushed[0].id, ref);
      assert.equal(typeof pushed[0].digest, "string"); // size/digest populated post-commit
      assert.equal(pushed[0].size, 1);
      pushed[0].meta.k = 999; // mutate the payload
      assert.equal((await stash.show(ref)).meta.k, 1, "the emit is a defensive copy");
      const dropped = [];
      stash.on("dropped", (e) => dropped.push(e.id));
      assert.equal(await stash.drop(ref), true);
      assert.deepEqual(dropped, [ref]);
      dropped.length = 0;
      await stash.push("a"); await stash.push("b");
      assert.equal(await stash.clear(), 2);
      assert.equal(dropped.length, 2, "clear emits 'dropped' per live entry");
    });

    test("a throwing 'pushed' listener does not unwind a committed push", async () => {
      const stash = new Stash({ backend: create() });
      stash.on("pushed", () => { throw new Error("listener boom"); });
      // the emit is synchronous, so push() rejects -- but the entry is committed
      await assert.rejects(stash.push("committed"), /listener boom/);
      const [entry] = await stash.list();
      assert.ok(entry, "the push committed before the listener threw");
      assert.equal(await stash.has(entry.id), true);
    });

    test("drop(expired) returns false and emits 'expired'; clear over live+expired counts only the live", async () => {
      const stash = new Stash({ backend: create() });
      const expiredRef = await stash.push("dead", { ttl: 0 });
      const events = [];
      stash.on("expired", (e) => events.push(["expired", e.id]));
      stash.on("dropped", (e) => events.push(["dropped", e.id]));
      assert.equal(await stash.drop(expiredRef), false, "an expired entry is nonexistent -> false");
      assert.deepEqual(events, [["expired", expiredRef]]);
      const live = await stash.push("live");
      await stash.push("dead2", { ttl: 0 });
      events.length = 0;
      assert.equal(await stash.clear(), 1, "only the live entry counts");
      assert.equal(events.filter(([k]) => k === "dropped").length, 1);
      assert.equal(events.filter(([k]) => k === "expired").length, 1);
      assert.ok(events.some(([k, id]) => k === "dropped" && id === live));
    });

    test("'expired' fires exactly once under a lazy-read / prune race, on both backends", async () => {
      for (const order of [0, 1]) {
        const stash = new Stash({ backend: create() });
        const ref = await stash.push("racer", { ttl: 0 });
        const seen = [];
        stash.on("expired", (e) => seen.push(e.id));
        const a = stash.show(ref).catch(() => {});
        const b = stash.prune();
        await Promise.all(order === 0 ? [a, b] : [b, a]);
        assert.deepEqual(seen, [ref], "the remove-witness makes it exactly one 'expired'");
      }
    });

    test("clear() destroys EVERY entry before emitting -- a throwing listener cannot leave the store half-cleared", async () => {
      const stash = new Stash({ backend: create() });
      await stash.push("a"); await stash.push("b"); await stash.push("c");
      stash.on("dropped", () => { throw new Error("listener boom"); }); // throws on the first emit
      await assert.rejects(stash.clear(), /listener boom/);
      assert.deepEqual(await stash.list(), [], "the whole store is cleared despite the throwing listener -- removes finish before events");
    });

    test("prune() reaps EVERY expired entry before emitting -- a throwing listener cannot strand one", async () => {
      const stash = new Stash({ backend: create() });
      await stash.push("x", { ttl: 0 }); await stash.push("y", { ttl: 0 });
      stash.on("expired", () => { throw new Error("listener boom"); });
      await assert.rejects(stash.prune(), /listener boom/);
      assert.deepEqual(await stash.list({ includeExpired: true }), [], "all expired entries reaped despite the throwing listener");
    });

    test("budget exhaustion emits 'dropped' not 'popped'; a pop emits 'popped' exactly once", async () => {
      const stash = new Stash({ backend: create() });
      const budgeted = await stash.push(Buffer.from("bud"), { reads: 1 });
      const ev = [];
      stash.on("dropped", (e) => ev.push(["dropped", e.id]));
      stash.on("popped", (e) => ev.push(["popped", e.id]));
      await drain(await stash.apply(budgeted)); // last credit -> destroy -> 'dropped'
      assert.deepEqual(ev, [["dropped", budgeted]]);
      ev.length = 0;
      const popRef = await stash.push("pop-me");
      await drain(await stash.pop(popRef));
      assert.deepEqual(ev, [["popped", popRef]]);
    });

    test("a burned pop emits 'popped' -- a burn's delete lands, never a silent destruction (SPEC.md 4.3)", { timeout: 8000 }, async () => {
      const stash = new Stash({ backend: create(), onPopFailure: "burn" });
      const ref = await stash.push(Buffer.alloc(65536, 7)); // above the highWaterMark: the stream holds, not auto-drained
      const poppedP = once(stash, "popped");
      const s = await stash.pop(ref);
      s.on("error", () => {}); // the premature destroy errors the stream; swallow it
      s.destroy(new Error("consumer aborted")); // premature -> onFail -> burn -> commit + emit 'popped'
      const [entry] = await poppedP;
      assert.equal(entry.id, ref, "the burned pop emitted 'popped'");
      assert.equal(await stash.has(ref), false, "the entry is gone (burned, not restored)");
    });

    test("a throwing sweep emits 'sweepError', never 'error', and the janitor survives", async () => {
      const inner = create();
      let failNext = true;
      const backend = wrapBackend(inner, {
        list: (...a) => { if (failNext) { failNext = false; throw new Error("sweep boom"); } return inner.list(...a); },
      });
      const stash = new Stash({ backend, sweepInterval: 20 }); // arm the sweep
      const errors = [];
      stash.on("error", () => errors.push("error")); // an unhandled 'error' would crash the process
      const [err] = await once(stash, "sweepError"); // poll via node:events once -- no sleep
      assert.equal(err.message, "sweep boom");
      assert.deepEqual(errors, [], "a background failure is 'sweepError', never the fatal 'error'");
      await stash.push("survivor"); // the janitor survived; a later op works
      assert.equal(await stash.prune(), 0);
      await stash.close();
    });

    test("an ASYNC-rejecting 'sweepError' listener is contained: no unhandledRejection, the janitor keeps sweeping", { timeout: 8000 }, async () => {
      // emit() does not await listeners, so an async handler that rejects returns a
      // promise nobody awaits -> an unhandledRejection (fatal on Node), the very
      // outcome the sweep exists to prevent. It must be contained like a sync throw.
      const inner = create();
      const backend = wrapBackend(inner, { list: () => { throw new Error("sweep boom"); } });
      const stash = new Stash({ backend, sweepInterval: 15 });
      const unhandled = [];
      const capture = (e) => unhandled.push(e);
      process.on("unhandledRejection", capture);
      let count = 0;
      try {
        stash.on("sweepError", async () => { count += 1; throw new Error("async handler boom"); }); // an async handler that REJECTS
        await pollUntil(() => count >= 2, { timeout: 6000 }); // the guard clears; later ticks keep sweeping
        await new Promise((r) => setTimeout(r, 40)); // give any escaped rejection a turn to surface
        assert.deepEqual(unhandled, [], "an async-rejecting sweepError handler never becomes an unhandledRejection");
      } finally {
        process.removeListener("unhandledRejection", capture);
        await stash.close();
      }
    });

    test("a THROWING 'sweepError' listener cannot brick the janitor: the in-flight guard clears and later ticks still sweep", { timeout: 8000 }, async () => {
      // A sweepError handler that itself throws must not (a) crash the process via
      // an unhandledRejection, nor (b) leave #sweepInFlight stuck so every later
      // tick no-ops -- silently disabling the janitor for the process's life. Every
      // sweep fails and every handler throws; seeing multiple sweepErrors proves the
      // guard cleared after the first throwing handler and the timer kept sweeping.
      const inner = create();
      const backend = wrapBackend(inner, { list: () => { throw new Error("sweep boom"); } });
      const stash = new Stash({ backend, sweepInterval: 15 });
      let sweepErrors = 0;
      const fatal = [];
      stash.on("error", () => fatal.push("error")); // an unhandled 'error' would crash the process
      stash.on("sweepError", () => { sweepErrors += 1; throw new Error("handler boom"); });
      await pollUntil(() => sweepErrors >= 2, { timeout: 6000 }); // >= 2 => the guard cleared and a later tick ran
      assert.deepEqual(fatal, [], "a throwing sweepError handler never escalates to the fatal 'error'");
      await stash.close();
    });

    test("for await (const entry of stash) yields the same id set as list()", async () => {
      const stash = new Stash({ backend: create() });
      const empty = [];
      for await (const e of stash) empty.push(e.id); // an empty stash completes at once
      assert.deepEqual(empty, []);
      const a = await stash.push("a"); const b = await stash.push("b");
      const ids = [];
      for await (const e of stash) ids.push(e.id);
      assert.deepEqual(ids.sort(), [a, b].sort());
    });

    // -- M7 Replication: store(), tombstones(), the SPEC.md 4.4 order of checks --

    test("store() files a fresh entry verbatim (step 6): identity preserved, show() returns the caller's fields", async () => {
      const stash = new Stash({ backend: create() });
      const id = generate();
      const entry = makeStoredEntry(id, "replicated bytes", { createdAt: 500, expiresAt: null, reads: 3, readsLeft: 2, meta: { k: { nested: 1 } } });
      assert.equal(await stash.store(entry, "replicated bytes"), true, "a fresh store returns true");
      const shown = await stash.show(id);
      assert.equal(shown.createdAt, 500, "createdAt is the caller's, not minted");
      assert.equal(shown.reads, 3);
      assert.equal(shown.readsLeft, 2, "a replica honors the REMAINING budget, never resets it");
      assert.deepEqual(shown.meta, { k: { nested: 1 } });
      assert.deepEqual(await drain(await stash.apply(id)), Buffer.from("replicated bytes"), "and the bytes round-trip");
    });

    test("store() refuses a tombstoned id -> false, writes nothing (step 2)", async () => {
      const stash = new Stash({ backend: create() });
      const id = await stash.push("live"); // then destroy it -> a grave
      await stash.drop(id);
      const entry = makeStoredEntry(id, "resurrect me");
      assert.equal(await stash.store(entry, "resurrect me"), false, "a tombstoned id never comes back");
      assert.equal(await stash.has(id), false, "nothing was written");
    });

    test("store() no-ops an entry already past its expiresAt -> false, no grave (step 3)", async () => {
      const stash = new Stash({ backend: create() });
      const id = generate();
      const entry = makeStoredEntry(id, "dead on arrival", { expiresAt: 1 }); // long past
      assert.equal(await stash.store(entry, "dead on arrival"), false);
      assert.equal(await stash.has(id), false, "the dead travel as dead -- nothing stored");
      assert.deepEqual(await stash.tombstones(), [], "and they get no grave");
    });

    test("store() is idempotent for an identical live entry (step 4): retry-based sync is free", async () => {
      const stash = new Stash({ backend: create() });
      const id = generate();
      const entry = makeStoredEntry(id, "same bytes");
      assert.equal(await stash.store(entry, "same bytes"), true, "first store lands");
      assert.equal(await stash.store(entry, "same bytes"), false, "identical retry is a no-op");
      assert.equal((await stash.list()).length, 1, "exactly one entry -- no duplicate");
    });

    test("store() throws IntegrityError on a digest conflict (step 5): the original is untouched", async () => {
      const stash = new Stash({ backend: create() });
      const id = generate();
      await stash.store(makeStoredEntry(id, "original"), "original");
      const conflicting = makeStoredEntry(id, "different"); // same id, different bytes+digest
      await assert.rejects(stash.store(conflicting, "different"), (e) => e instanceof IntegrityError && e.code === "EINTEGRITY");
      assert.deepEqual(await drain(await stash.apply(id)), Buffer.from("original"), "the existing entry still applies to the original bytes");
    });

    test("store() reconciles identical bytes under a DIFFERENT algorithm as an idempotent no-op (step 4 by byte identity)", async () => {
      // SPEC.md 4.4 step 4 no-ops "same id, same digest" and step 5 conflicts on "same
      // id, different BYTES"; SPEC.md 5 makes mixed-algorithm stores first-class. Two
      // entries with IDENTICAL bytes but different algorithms carry different digest
      // STRINGS -- so reconciliation keys on byte identity, not the algo-tagged string,
      // or an identical-bytes replica wedges permanently on a spurious digest conflict.
      const stash = new Stash({ backend: create() });
      const bytes = "content that outlives its algorithm";
      const id = generate();
      assert.equal(await stash.store(storedEntryUnder(id, bytes, "sha256"), bytes), true, "first store lands under sha256");
      const sha3 = storedEntryUnder(id, bytes, "sha3-512");
      assert.equal(await stash.store(sha3, bytes), false, "identical bytes, different algorithm -> idempotent no-op");
      assert.equal(await stash.store(sha3, bytes), false, "and the retry is still free -- reconciliation never wedges");
      assert.equal((await stash.list()).length, 1, "exactly one entry -- no duplicate");
      assert.equal((await stash.show(id)).digest, storedEntryUnder(id, bytes, "sha256").digest, "the stored entry keeps its ORIGINAL algorithm -- nothing was rewritten");
      assert.deepEqual(await drain(await stash.apply(id)), Buffer.from(bytes), "and the bytes still round-trip");
      // Symmetric: existing under sha3-512, incoming under sha256 -- the existing entry's
      // OWN algorithm decides byte identity, so it reconciles in either direction.
      const id2 = generate();
      assert.equal(await stash.store(storedEntryUnder(id2, bytes, "sha3-512"), bytes), true);
      assert.equal(await stash.store(storedEntryUnder(id2, bytes, "sha256"), bytes), false, "existing sha3-512, incoming sha256 -> idempotent");
    });

    test("store() still flags a CROSS-algorithm digest conflict as IntegrityError (step 5): different bytes never masquerade as idempotent", async () => {
      // The fail-open trap: a naive fix ("different algorithm -> false") would silently
      // accept genuinely different bytes as a no-op, masking the very conflict step 5
      // exists to surface. Different bytes is a conflict regardless of algorithm.
      const stash = new Stash({ backend: create() });
      const id = generate();
      await stash.store(storedEntryUnder(id, "the original content", "sha256"), "the original content");
      const conflicting = storedEntryUnder(id, "a genuinely different payload", "sha3-512"); // different bytes AND algorithm
      await assert.rejects(stash.store(conflicting, "a genuinely different payload"),
        (e) => e instanceof IntegrityError && e.code === "EINTEGRITY");
      assert.deepEqual(await drain(await stash.apply(id)), Buffer.from("the original content"), "the existing entry is untouched");
      assert.equal((await stash.show(id)).digest, storedEntryUnder(id, "the original content", "sha256").digest, "and keeps its original algorithm/digest");
    });

    test("store() catches a lying CROSS-algorithm entry (digest disagrees with its own bytes) -> IntegrityError, nothing changes", async () => {
      // Reconciling cross-algorithm still verifies the incoming bytes against the
      // incoming entry's OWN manifest -- an untrusted replica that lies about its own
      // digest is caught exactly as the write path catches it, never trusted into a no-op.
      const stash = new Stash({ backend: create() });
      const id = generate();
      await stash.store(storedEntryUnder(id, "stored content", "sha256"), "stored content");
      const lie = storedEntryUnder(id, "stored content", "sha3-512"); // digest over "stored content"...
      await assert.rejects(stash.store(lie, "STORED CONTENT"), // ...but streams different (same-length) bytes
        (e) => e instanceof IntegrityError && e.code === "EINTEGRITY");
      assert.deepEqual(await drain(await stash.apply(id)), Buffer.from("stored content"), "the existing entry is untouched");
    });

    test("store() order is normative: step 2 (tombstoned) beats step 5 (digest conflict) -> false, not IntegrityError", async () => {
      const stash = new Stash({ backend: create() });
      const id = await stash.push("held"); await stash.drop(id); // grave for id
      const conflicting = makeStoredEntry(id, "conflicting bytes");
      assert.equal(await stash.store(conflicting, "conflicting bytes"), false, "the grave wins over the conflict verdict");
    });

    test("store() malformed id is InvalidRef before any backend access (step 1)", async () => {
      const stash = new Stash({ backend: create() });
      for (const bad of ["../../etc/passwd", "v1_..", "not-a-ref", ""]) {
        const entry = makeStoredEntry("v1_placeholderplaceholderplaceholderplaceholder", "x");
        entry.id = bad;
        await assert.rejects(stash.store(entry, "x"), (e) => e instanceof InvalidRef && e.code === "EBADREF");
      }
    });

    test("store() catches transfer corruption: a digest lie and a size lie both IntegrityError, nothing lands", async () => {
      const stash = new Stash({ backend: create() });
      const idA = generate();
      const digestLie = makeStoredEntry(idA, "the real bytes");
      await assert.rejects(stash.store(digestLie, "DIFFERENT bytes"), IntegrityError); // digest disagrees with the stream
      assert.equal(await stash.has(idA), false, "a digest mismatch leaves nothing");
      const idB = generate();
      const sizeLie = makeStoredEntry(idB, "exact"); sizeLie.size += 1; // digest right, size off by one
      await assert.rejects(stash.store(sizeLie, "exact"), IntegrityError);
      assert.equal(await stash.has(idB), false, "a size mismatch leaves nothing");
    });

    test("store() is SILENT -- zero emissions across the whole event set (echo-suppression, SPEC.md 4.4)", async () => {
      const stash = new Stash({ backend: create() });
      const seen = [];
      for (const ev of ["pushed", "popped", "dropped", "expired"]) stash.on(ev, () => seen.push(ev));
      await stash.store(makeStoredEntry(generate(), "quiet"), "quiet");
      assert.deepEqual(seen, [], "a sync daemon must not hear its own writes");
    });

    test("store() rejects a hostile entry through the shipped path -- shape violations are IntegrityError, nothing written", async () => {
      const stash = new Stash({ backend: create() });
      const good = makeStoredEntry(generate(), "x");
      const hostiles = [
        { ...good, extra: 1 },                       // extra field
        (() => { const e = { ...good }; delete e.digest; return e; })(), // missing field
        { ...good, digest: "sha256:nothex" },        // digest not sha256-hex
        { ...good, size: -1 },                       // negative size
        { ...good, reads: 2, readsLeft: null },      // budget incoherence
        { ...good, reads: 1, readsLeft: 5 },         // readsLeft > reads
        { ...good, reads: 3, readsLeft: 0 },         // exhausted budget -- a live entry never has readsLeft 0
        { ...good, meta: [1, 2] },                   // non-plain meta
      ];
      for (const h of hostiles) await assert.rejects(stash.store(h, "x"), IntegrityError);
      assert.deepEqual(await stash.list(), [], "not one hostile entry landed");
    });

    test("store() rejects a meta that serializes to a scalar (Date / toJSON-scalar) -- no unreadable entry lands", async () => {
      // A replicated meta that is not a plain JSON object -- a Date, or a plain object
      // whose toJSON() returns a scalar -- would be stored (via JSON.stringify) as a
      // SCALAR and then rejected by every later show()/list() read: a store() that
      // "succeeds" into an unreadable entry. It is untrusted input, normalized to its
      // stored form and refused as IntegrityError before anything lands.
      for (const badMeta of [new Date(), { toJSON: () => 5 }, { toJSON: () => "scalar" }]) {
        const stash = new Stash({ backend: create() });
        const id = generate();
        await assert.rejects(stash.store(makeStoredEntry(id, "bytes", { meta: badMeta }), "bytes"), IntegrityError);
        assert.equal(await stash.has(id), false, "nothing lands");
        assert.deepEqual(await stash.list(), [], "the store holds no unreadable entry -- list() does not choke");
      }
    });

    test("store() accepts the same source set as push (Buffer, string, Uint8Array, Readable, AsyncIterable); a non-source is a TypeError", async () => {
      const bytes = Buffer.from("source shapes");
      for (const src of [bytes, "source shapes", new Uint8Array(bytes), () => Readable.from([bytes]), () => (async function* () { yield bytes; })()]) {
        const stash = new Stash({ backend: create() });
        const id = generate();
        const entry = makeStoredEntry(id, bytes);
        const source = typeof src === "function" ? src() : src;
        assert.equal(await stash.store(entry, source), true);
        assert.deepEqual(await drain(await stash.apply(id)), bytes);
      }
      const stash = new Stash({ backend: create() });
      for (const bad of [42, null, {}, [bytes]]) {
        await assert.rejects(stash.store(makeStoredEntry(generate(), bytes), bad), TypeError);
      }
    });

    test("store() honors the stash limits like push: over maxSize -> SizeExceeded, past maxEntries/maxTotal -> StashFull, nothing lands", async () => {
      // A replicated entry is untrusted -- it must not slip the configured capacity.
      { // maxSize: a replica whose bytes exceed the per-entry cap aborts mid-stream.
        const stash = new Stash({ backend: create(), maxSize: 8 });
        const id = generate();
        await assert.rejects(stash.store(makeStoredEntry(id, "waaaay too many bytes"), "waaaay too many bytes"), SizeExceeded);
        assert.equal(await stash.has(id), false, "an oversized replica leaves nothing behind");
      }
      { // maxEntries: the first fills the cap; the replica past it is StashFull.
        const stash = new Stash({ backend: create(), maxEntries: 1 });
        assert.equal(await stash.store(makeStoredEntry(generate(), "one"), "one"), true);
        const id2 = generate();
        await assert.rejects(stash.store(makeStoredEntry(id2, "two"), "two"), StashFull);
        assert.equal(await stash.has(id2), false, "the over-cap replica leaves nothing");
      }
      { // maxTotal: the blob+sidecar footprint is charged; a big blob past headroom is StashFull.
        const big = Buffer.alloc(1000, 65);
        const stash = new Stash({ backend: create(), maxTotal: 1500 });
        assert.equal(await stash.store(makeStoredEntry(generate(), big), big), true);
        const id2 = generate();
        await assert.rejects(stash.store(makeStoredEntry(id2, big), big), StashFull);
        assert.equal(await stash.has(id2), false);
      }
    });

    test("concurrent same-id store()s do not both land: conflicting replicas reconcile, no raw error, ONE consistent entry", async () => {
      // Two sync workers filing conflicting replicas of one id must not both pass the
      // reconcile and race the write (memory would last-writer-win; disk would raw-EEXIST
      // on the shared blob tmp). The insert is serialized per id: exactly one lands, the
      // rest reconcile (idempotent-false or IntegrityError), and the stored entry is
      // internally consistent -- never a torn mix of two replicas.
      { // conflicting digests -> exactly one lands, losers are typed, no raw fs error
        const stash = new Stash({ backend: create() });
        const id = generate();
        const racers = ["alpha", "bravo", "charlie", "delta"].map((b) => stash.store(makeStoredEntry(id, b), b));
        const settled = await Promise.allSettled(racers);
        for (const r of settled) {
          if (r.status === "rejected") {
            assert.ok(r.reason instanceof IntegrityError, "a losing conflict is IntegrityError, never a raw fs error: " + (r.reason && r.reason.stack));
          }
        }
        assert.equal(settled.filter((r) => r.status === "fulfilled" && r.value === true).length, 1, "exactly one replica lands");
        const bytes = await drain(await stash.apply(id));
        const stored = await stash.show(id);
        assert.equal("sha256:" + createHash("sha256").update(bytes).digest("hex"), stored.digest, "the landed entry is not a torn mix of the racers");
      }
      { // identical replicas -> idempotent, exactly one entry, both settle cleanly
        const stash = new Stash({ backend: create() });
        const id = generate();
        const e = makeStoredEntry(id, "same");
        const settled = await Promise.allSettled([stash.store(e, "same"), stash.store(e, "same"), stash.store(e, "same")]);
        for (const r of settled) assert.equal(r.status, "fulfilled", "identical concurrent stores settle cleanly");
        assert.equal(settled.filter((r) => r.value === true).length, 1, "one lands");
        assert.ok(settled.filter((r) => r.value === false).length >= 1, "the rest are idempotent no-ops");
        assert.equal((await stash.list()).length, 1, "exactly one entry");
        assert.deepEqual(await drain(await stash.apply(id)), Buffer.from("same"));
      }
    });

    test("two stores converge (the done-when): a pop on A never resurrects after syncing B back", async () => {
      const A = new Stash({ backend: create() });
      const B = new Stash({ backend: create() });
      const payload = Buffer.from("bytes to replicate");
      const id = await A.push(payload);
      const bytesOf = () => Buffer.from(payload); // the harness replays the pushed payload (never re-reads a budgeted entry)
      await syncOnce(A, B, bytesOf);                       // B now holds the copy
      assert.deepEqual(await drain(await B.apply(id)), payload, "B replicated it");
      await drain(await A.pop(id));                         // A pops it -> a 'pop' grave on A
      await syncOnce(B, A, bytesOf);                        // B tries to re-file its copy onto A
      assert.deepEqual(await A.list(), [], "A stays empty -- the grave refused the re-file");
      await assert.rejects(A.show(id), RefNotFound);
      const graves = await A.tombstones();
      assert.equal(graves.length, 1);
      assert.equal(graves[0].id, id);
      assert.equal(graves[0].cause, "pop", "the grave records how it died");
      await syncOnce(A, B, bytesOf);                        // and A's grave propagates to B
      assert.deepEqual(await B.list(), [], "both stores converge to empty");
    });

    test("reconcilable() is the resilient source read: healthy entries plus an empty corrupt set, a clean drop-in for the sync loop", async () => {
      // The reconciliation-grade listing (SPEC.md 4.4). On an uncorrupted store it
      // returns every healthy entry (expired filtered, exactly as list()) and an
      // empty corrupt set -- so it is a byte-for-byte drop-in for the documented
      // anti-entropy source read. The disk-only corrupt-sidecar vector proves it
      // keeps enumerating past damage; this cross-backend case pins the clean shape.
      const from = new Stash({ backend: create() });
      const to = new Stash({ backend: create() });
      const wire = new Map();
      const put = async (bytes, opts) => {
        const ref = await from.push(bytes, opts);
        wire.set(ref, Buffer.from(bytes));
        return ref;
      };
      const a = await put("alpha");
      const budgeted = await put("read me twice", { reads: 2 });
      const c = await put("charlie");
      await put("already dead", { ttl: 0 }); // expired -> filtered, exactly as list()

      const { entries, corrupt } = await from.reconcilable();
      assert.deepEqual(corrupt, [], "no corruption -> an empty corrupt set");
      assert.deepEqual(entries.map((e) => e.id).sort(), [a, budgeted, c].sort(), "the expired entry is filtered, the live ones listed");

      // Drives the documented loop end to end; the read budget survives the copy.
      for (const grave of await from.tombstones()) await to.drop(grave.id);
      for (const entry of entries) await to.store(entry, wire.get(entry.id));
      assert.equal((await to.list()).length, 3, "every healthy entry replicated");
      assert.equal((await to.show(budgeted)).readsLeft, 2, "the budget rode through reconcilable() -> store() intact");
    });

    test("a grave propagates through an EMPTY replica: a node that never held the id adopts the grave, refusing a later resurrection", async () => {
      // Reconciliation propagates graves by drop()-ing each of the other node's grave ids
      // (SPEC.md 4.4). A node that never held the id must still ADOPT the grave, or a later
      // sync from a stale node resurrects the entry the destruction removed.
      const A = new Stash({ backend: create() });
      const B = new Stash({ backend: create() }); // empty -- never holds the id
      const C = new Stash({ backend: create() }); // stale -- still has a live copy
      const payload = Buffer.from("burned on A");
      const id = await A.push(payload);
      assert.equal(await C.store(makeStoredEntry(id, payload), payload), true, "C holds a live copy");
      await drain(await A.pop(id)); // A pops it -> a grave on A
      // Sync A -> B: propagate A's grave to the EMPTY B (the done-when's drop loop).
      for (const g of await A.tombstones()) assert.equal(await B.drop(g.id), false, "nothing live on B, but the grave is adopted");
      assert.equal((await B.tombstones()).length, 1, "B adopted the grave though it never held the id");
      // A stale C now tries to re-file its live copy onto B -- the propagated grave refuses it.
      assert.equal(await B.store(makeStoredEntry(id, payload), payload), false, "the propagated grave refuses the resurrection");
      await assert.rejects(B.show(id), RefNotFound);
    });

    test("expiry writes NO grave (lazy read path AND sweeper); clear writes one per live entry; drop of an absent id STILL writes a grave (propagation)", async () => {
      const s1 = new Stash({ backend: create() });
      const dead = await s1.push("dead", { ttl: 0 });
      await s1.show(dead).catch(() => {}); // lazy read reaps the expired entry
      assert.deepEqual(await s1.tombstones(), [], "an expired entry leaves no grave -- its terms travel with it");

      const s2 = new Stash({ backend: create() });
      await s2.push("a"); await s2.push("b");
      assert.equal(await s2.clear(), 2);
      const graves = await s2.tombstones();
      assert.equal(graves.length, 2, "clear writes one grave per live entry");
      assert.ok(graves.every((g) => g.cause === "clear"));

      const s3 = new Stash({ backend: create() });
      const absent = generate();
      assert.equal(await s3.drop(absent), false, "no LIVE entry was destroyed");
      const g3 = await s3.tombstones();
      assert.equal(g3.length, 1, "but the id is tombstoned -- a grave propagates through a node that never held it");
      assert.equal(g3[0].id, absent);
      assert.equal(g3[0].cause, "drop");
    });

    test("concurrent same-id destroyers converge to ONE grave with a clean verdict -- no raw fs error escapes", async () => {
      // drop and clear take no claim, so drop||drop and drop||pop bury one id at once
      // (the claim only serializes pop-vs-pop). The grave write must be first-write-wins
      // WITHOUT a shared-tmp collision surfacing a raw, path-bearing fs error out of the
      // public verb, and WITHOUT clobbering the first grave's cause. Fan several racers
      // at one id to force the overlap window: every settle is clean, exactly one grave
      // stands, and the entry is gone. (On disk pre-fix, a loser threw a raw EEXIST.)
      const popDrain = async (s, id) => {
        try { await drain(await s.pop(id)); }
        catch (e) { if (!(e instanceof RefClaimed) && !(e instanceof RefNotFound)) throw e; }
      };
      const scenarios = [
        (s, id) => [s.drop(id), s.drop(id), s.drop(id), s.drop(id)],
        (s, id) => [popDrain(s, id), s.drop(id), s.drop(id)],
      ];
      for (const racers of scenarios) {
        const stash = new Stash({ backend: create() });
        const id = await stash.push("bytes to bury once");
        const settled = await Promise.allSettled(racers(stash, id));
        for (const r of settled) {
          if (r.status === "rejected") {
            assert.ok(r.reason instanceof StashError, "a losing racer rejects TYPED, never a raw fs error: " + (r.reason && r.reason.stack));
          }
        }
        assert.equal(await stash.has(id), false, "the entry is destroyed exactly once");
        const graves = await stash.tombstones();
        assert.equal(graves.length, 1, "exactly one grave stands (first-write-wins, no clobber)");
        assert.equal(graves[0].id, id);
        assert.ok(["pop", "drop", "clear", "spent"].includes(graves[0].cause), "the grave records a valid cause");
      }
    });

    test("a budgeted entry replicated to both stores is eventually-once: each serves one drain, both bury it 'spent'", async () => {
      const A = new Stash({ backend: create() });
      const B = new Stash({ backend: create() });
      const payload = Buffer.from("read once per replica");
      const id = generate();
      const entry = makeStoredEntry(id, payload, { reads: 1, readsLeft: 1 });
      assert.equal(await A.store(entry, payload), true);
      assert.equal(await B.store(entry, payload), true); // the SAME budgeted entry on both
      assert.deepEqual(await drain(await A.apply(id)), payload, "A serves its one read");
      assert.deepEqual(await drain(await B.apply(id)), payload, "B serves its one read too (eventually-once)");
      for (const s of [A, B]) {
        const graves = await s.tombstones();
        assert.equal(graves.length, 1);
        assert.equal(graves[0].cause, "spent", "a spent budget buries the entry 'spent'");
      }
    });

    test("tombstones survive prune() until tombstoneTtl, then are pruned; after pruning store() of that id succeeds (the floor-rule consequence)", async () => {
      const stash = new Stash({ backend: create(), tombstoneTtl: 40 });
      const id = await stash.push("bury me");
      await stash.drop(id); // a grave
      await stash.prune();
      assert.equal((await stash.tombstones()).length, 1, "a fresh grave survives prune()");
      await pollUntil(async () => { await stash.prune(); return (await stash.tombstones()).length === 0; }, { timeout: 3000 });
      assert.equal(await stash.store(makeStoredEntry(id, "reborn"), "reborn"), true, "past the ttl, the id can be stored again -- the documented floor rule");
    });

    test("tombstoneTtl: null never prunes -- a grave survives arbitrarily many prune() calls", async () => {
      const stash = new Stash({ backend: create(), tombstoneTtl: null });
      const id = await stash.push("permanent grave");
      await stash.drop(id);
      for (let i = 0; i < 5; i += 1) await stash.prune();
      assert.equal((await stash.tombstones()).length, 1, "null tombstoneTtl keeps the grave forever");
    });

    test("the backend tombstone contract: first-write-wins, and absent/traversal answers on the subpath surface", async () => {
      const backend = create();
      const id = generate();
      await backend.writeTombstone(id, { id, destroyedAt: 1000, cause: "drop" });
      await backend.writeTombstone(id, { id, destroyedAt: 9999, cause: "pop" }); // a newer write must NOT overwrite
      const [g] = await backend.listTombstones();
      assert.equal(g.destroyedAt, 1000, "first-write-wins -- the original destroyedAt stands");
      assert.equal(g.cause, "drop");
      assert.equal(await backend.hasTombstone(generate()), false, "an absent id has no grave");
      assert.deepEqual(await backend.listTombstones().then((l) => l.filter((t) => t.id !== id)), []);
      assert.equal(await backend.removeTombstone(generate()), false, "removing an absent grave is false");
      assert.equal(await backend.removeTombstone(id), true, "removing a held grave is true");
      for (const bad of ["../escape", "v1_..", "not-a-ref"]) {
        await assert.rejects(backend.hasTombstone(bad), InvalidRef);
        await assert.rejects(backend.writeTombstone(bad, { id: bad, destroyedAt: 1, cause: "drop" }), InvalidRef);
        await assert.rejects(backend.removeTombstone(bad), InvalidRef);
      }
    });
  });
}

suite("clear under concurrent destruction", () => {
  test("an entry that vanishes between list and remove is not counted", async () => {
    // A remove that reports false mid-clear models a concurrent drop --
    // the count is actual destructions, not the length of the listing.
    const inner = new MemoryBackend();
    let vanish = null;
    const backend = wrapBackend(inner, {
      remove: async (id) => {
        if (id === vanish) {
          vanish = null;
          await inner.remove(id);
          return false; // someone else already destroyed it
        }
        return inner.remove(id);
      },
    });
    const stash = new Stash({ backend });
    await stash.push("survives the race");
    vanish = await stash.push("already gone");
    assert.equal(await stash.clear(), 1);
    assert.deepEqual(await stash.list(), []);
  });
});

suite("prune under concurrent destruction", () => {
  test("an expired entry that vanishes between list and remove is not counted", async () => {
    const inner = new MemoryBackend();
    let vanish = null;
    const backend = {
      ...wrapBackend(inner),
      write: (...a) => inner.write(...a),
      read: (...a) => inner.read(...a),
      stat: (...a) => inner.stat(...a),
      list: (...a) => inner.list(...a),
      stats: (...a) => inner.stats(...a),
      remove: async (id) => {
        if (id === vanish) { vanish = null; await inner.remove(id); return false; }
        return inner.remove(id);
      },
    };
    const stash = new Stash({ backend });
    await stash.push("expired survivor", { ttl: 0 });
    vanish = await stash.push("expired, already gone", { ttl: 0 });
    // both are expired; one vanishes mid-prune -- the count is actual
    // destructions (1), not the number of expired entries seen (2)
    assert.equal(await stash.prune(), 1);
  });
});

suite("M3 lifecycle: sweeper, close, disposal (SPEC.md 7, 7.1)", () => {
  test("the sweeper destroys expired entries with no read verb", async () => {
    const stash = new Stash({ backend: new MemoryBackend(), sweepInterval: 5 });
    await stash.push("x", { ttl: 0 });
    await pollUntil(async () => (await stash.list({ includeExpired: true })).length === 0);
    await stash.close();
  });

  test("close() stops the sweeper", async () => {
    const stash = new Stash({ backend: new MemoryBackend(), sweepInterval: 5 });
    await stash.close();
    await stash.push("x", { ttl: 0 });
    // absence window (drift rule 6b): prove NO sweep runs after close
    await new Promise((r) => setTimeout(r, 60));
    assert.equal((await stash.list({ includeExpired: true })).length, 1);
  });

  test("close is idempotent; Symbol.asyncDispose twice does not throw; close with no timer is safe", async () => {
    const stash = new Stash({ backend: new MemoryBackend(), sweepInterval: 5 });
    await stash.close();
    await stash.close();
    await stash[Symbol.asyncDispose]();
    await stash[Symbol.asyncDispose]();
    const noTimer = new Stash({ backend: new MemoryBackend() });
    await noTimer.close();
    await noTimer[Symbol.asyncDispose]();
  });

  test("await using disposes the sweeper, even when the block throws", async () => {
    let captured;
    {
      await using stash = new Stash({ backend: new MemoryBackend(), sweepInterval: 5 });
      captured = stash;
      await stash.push("x", { ttl: 0 });
    }
    // after the block the timer is cleared: a new expired entry is not swept
    await captured.push("y", { ttl: 0 });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal((await captured.list({ includeExpired: true })).length, 2);

    let captured2;
    await assert.rejects((async () => {
      await using stash = new Stash({ backend: new MemoryBackend(), sweepInterval: 5 });
      captured2 = stash;
      throw new Error("boom");
    })());
    await captured2.push("z", { ttl: 0 });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal((await captured2.list({ includeExpired: true })).length, 1);
  });

  test("a throwing sweep does not crash the process and keeps firing", async () => {
    const inner = new MemoryBackend();
    let ticks = 0;
    const backend = {
      ...wrapBackend(inner),
      write: (...a) => inner.write(...a),
      read: (...a) => inner.read(...a),
      stat: (...a) => inner.stat(...a),
      remove: (...a) => inner.remove(...a),
      stats: (...a) => inner.stats(...a),
      list: async () => { ticks += 1; throw new Error("sweep boom"); },
    };
    const stash = new Stash({ backend, sweepInterval: 5 });
    // fired, failed, and fired AGAIN -- the silent catch did not wedge the timer
    await pollUntil(() => ticks >= 2);
    // the store still serves the non-list verbs
    const ref = await stash.push("still works");
    assert.equal((await stash.show(ref)).id, ref);
    await stash.close();
  });

  test("sweeps do not overlap: a slow prune is never re-entered", async () => {
    const inner = new MemoryBackend();
    let inFlight = 0;
    let maxConcurrent = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const backend = {
      ...wrapBackend(inner),
      write: (...a) => inner.write(...a),
      read: (...a) => inner.read(...a),
      stat: (...a) => inner.stat(...a),
      remove: (...a) => inner.remove(...a),
      stats: (...a) => inner.stats(...a),
      list: async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await gate; // hold the first sweep open while more ticks fire
        inFlight -= 1;
        return inner.list();
      },
    };
    const stash = new Stash({ backend, sweepInterval: 5 });
    await pollUntil(() => inFlight === 1);
    await new Promise((r) => setTimeout(r, 40)); // absence window: more ticks would fire here
    assert.equal(maxConcurrent, 1, "the in-flight flag kept sweep concurrency at 1");
    release();
    await stash.close();
  });

  test("close() awaits an in-flight sweep: no deletion lands after it resolves", async () => {
    const inner = new MemoryBackend();
    let releaseList;
    const listGate = new Promise((r) => { releaseList = r; });
    let sweepEnteredList = false;
    let closeResolved = false;
    let removedAfterClose = false;
    const backend = {
      ...wrapBackend(inner),
      write: (...a) => inner.write(...a),
      read: (...a) => inner.read(...a),
      stat: (...a) => inner.stat(...a),
      stats: (...a) => inner.stats(...a),
      list: async () => { sweepEnteredList = true; await listGate; return inner.list(); },
      remove: async (id) => { if (closeResolved) removedAfterClose = true; return inner.remove(id); },
    };
    const stash = new Stash({ backend, sweepInterval: 5 });
    await stash.push("x", { ttl: 0 });
    await pollUntil(() => sweepEnteredList); // a sweep is now blocked inside list()
    const closePromise = stash.close().then(() => { closeResolved = true; });
    // close() must NOT resolve while the sweep it caught is still running
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(closeResolved, false, "close() awaited the in-flight sweep instead of resolving early");
    releaseList(); // let the sweep finish -- it reaps the expired entry now
    await closePromise;
    assert.equal(removedAfterClose, false, "the sweep's deletion happened before close() resolved, not after");
  });

  test("a sweepInterval above Node's timer ceiling, or of zero, is a config error", async () => {
    assert.throws(() => new Stash({ backend: new MemoryBackend(), sweepInterval: "30d" }), TypeError);
    assert.throws(() => new Stash({ backend: new MemoryBackend(), sweepInterval: 0 }), TypeError);
    assert.throws(() => new Stash({ backend: new MemoryBackend(), sweepInterval: C.TIME.MAX_TIMER_MS + 1 }), TypeError);
    // a value exactly at the ceiling is accepted
    const ok = new Stash({ backend: new MemoryBackend(), sweepInterval: C.TIME.MAX_TIMER_MS });
    await ok.close();
  });

  test("a default ttl whose expiresAt would overflow is refused at construction, not at first push", () => {
    // A valid duration whose createdAt + ttl leaves the safe integer range must
    // fail at config time -- not construct fine and then break every push.
    assert.throws(() => new Stash({ backend: new MemoryBackend(), ttl: Number.MAX_SAFE_INTEGER }), TypeError);
    // a duration string large enough to overflow against the current clock too
    assert.throws(() => new Stash({ backend: new MemoryBackend(), ttl: "104249991d" }), TypeError);
    // an ordinary default still constructs and pushes
    const ok = new Stash({ backend: new MemoryBackend(), ttl: "24h" });
    return ok.push("x").then((ref) => ok.show(ref)).then((e) => assert.equal(e.expiresAt, e.createdAt + 86400000));
  });

  test("a process with an open sweeping Stash exits on its own (the unref rule)", { skip: SANDBOXED, timeout: 15000 }, async () => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const nodePath = await import("node:path");
    const root = nodePath.resolve(fileURLToPath(import.meta.url), "..", "..");
    const indexUrl = pathToFileURL(nodePath.join(root, "src", "index.js")).href;
    const memUrl = pathToFileURL(nodePath.join(root, "src", "backends", "memory.js")).href;
    const code = [
      "import { Stash } from " + JSON.stringify(indexUrl) + ";",
      "import { MemoryBackend } from " + JSON.stringify(memUrl) + ";",
      "const s = new Stash({ backend: new MemoryBackend(), sweepInterval: '1h' });",
      "await s.push('x', { ttl: '1h' });",
      // never close(): if the sweep timer were not unref'd, the process would
      // hang here and the spawn would time out and be killed.
    ].join("\n");
    const rv = spawnSync(process.execPath, ["--input-type=module", "-e", code], { timeout: 10000, encoding: "utf8" });
    assert.equal(rv.signal, null, "child was not killed -- the unref'd timer let it exit: " + (rv.stderr || ""));
    assert.equal(rv.status, 0, "child exited cleanly: " + (rv.stderr || ""));
  });
});

// The backend interface is public surface (the subpath export) and Stash is
// not its only caller: SPEC.md 9 binds the backend's own verdicts. Stash
// happens to gate read() behind stat(), so read's not-found path is
// unreachable through apply -- these drive the contract directly, and every
// future backend inherits the cases through the same BACKENDS loop.
for (const { name, create } of BACKENDS) {
  suite("backend contract: " + name, () => {
    test("read and stat on an absent id throw RefNotFound; remove reports false", async () => {
      const backend = create();
      const absent = generate();
      await assert.rejects(backend.read(absent), RefNotFound);
      await assert.rejects(backend.stat(absent), RefNotFound);
      assert.equal(await backend.remove(absent), false);
    });

    test("stats() is { entries, bytes, claimed } of non-negative safe integers, and tracks writes and removes", async () => {
      const backend = create();
      assert.deepEqual(await backend.stats(), { entries: 0, bytes: 0, claimed: 0 });
      const id = generate();
      const skeleton = { id, size: 0, digest: null, createdAt: 0, expiresAt: null, reads: null, readsLeft: null, meta: {} };
      await backend.write(id, [Buffer.alloc(9, 1)], skeleton);
      const s = await backend.stats();
      assert.equal(s.entries, 1);
      assert.ok(s.bytes > 9, "footprint counts the sidecar metadata, not just the 9 blob bytes");
      assert.equal(s.claimed, 0);
      for (const v of [s.entries, s.bytes, s.claimed]) assert.equal(Number.isSafeInteger(v) && v >= 0, true);
      await backend.remove(id);
      assert.deepEqual(await backend.stats(), { entries: 0, bytes: 0, claimed: 0 });
    });

    test("claim / restore / commit / consumeRead / listClaims form the claim contract", async () => {
      const backend = create();
      await assert.rejects(backend.claim(generate()), RefNotFound); // nothing to claim

      const id = generate();
      const payload = Buffer.alloc(20, 7);
      const skeleton = { id, size: 0, digest: null, createdAt: 0, expiresAt: null, reads: 2, readsLeft: 2, meta: {} };
      await backend.write(id, [payload], skeleton);

      // claim moves the entry and hands back its bytes; a second claim loses.
      const claimed = await backend.claim(id);
      assert.equal(claimed.entry.id, id);
      assert.deepEqual(await drain(claimed.source), payload);
      await assert.rejects(backend.claim(id), RefClaimed);
      await assert.rejects(backend.read(id), RefClaimed); // a claimed blob is not "absent"
      const claims = await backend.listClaims();
      assert.equal(claims.length, 1);
      assert.equal(claims[0].id, id);
      assert.equal(Number.isSafeInteger(claims[0].claimedAt), true);

      // consumeRead debits the budget; restore returns the entry, decrement kept.
      assert.equal(await backend.consumeRead(id), 1);
      await backend.restore(id);
      assert.equal((await backend.stat(id)).readsLeft, 1);
      assert.deepEqual(await backend.listClaims(), []);
      assert.deepEqual(await drain(await backend.read(id)), payload); // round-trips

      // claim -> commit destroys it: gone from stat/read/listClaims.
      const again = await backend.claim(id);
      again.source.destroy();
      await backend.commit(id);
      await assert.rejects(backend.stat(id), RefNotFound);
      assert.equal(await backend.remove(id), false);
      assert.deepEqual(await backend.listClaims(), []);
    });
  });
}

// M9 digest agility: the integrity hash is a construct-time choice, the stored
// digest is self-describing ("algo:hex"), and reads verify with the entry's OWN
// algorithm. Runs against every backend.
const DIGEST_ALGOS = Object.keys(DIGESTS); // sha256, sha512, sha3-256, sha3-512, shake256
const digestOf = (bytes, algo) => finalize(digestHash(algo).update(Buffer.from(bytes)), algo);

for (const { name, create } of BACKENDS) {
  suite("M9 digest agility: " + name, () => {
    for (const algo of DIGEST_ALGOS) {
      test(`push+apply round-trips under digest '${algo}'; the stored digest is the algo's hash, self-describing, verified on read`, async () => {
        const stash = new Stash({ backend: create(), digest: algo });
        const payload = Buffer.from("bytes hashed with " + algo);
        const ref = await stash.push(payload);
        const stored = await stash.show(ref);
        assert.equal(stored.digest, digestOf(payload, algo), "the stored digest is the algorithm's hash of the bytes");
        assert.ok(stored.digest.startsWith(algo + ":"), "the stored digest names its algorithm");
        assert.deepEqual(await drain(await stash.apply(ref)), payload, "the read verifies with the stored algorithm");
      });
    }

    test("a store holds MIXED algorithms: a sha256 and a sha3-512 entry each apply and verify() clean (self-describing per entry)", async () => {
      const backend = create();
      const s256 = new Stash({ backend, digest: "sha256" });
      const a = await s256.push("first, sha256");
      const s3 = new Stash({ backend, digest: "sha3-512" });
      const b = await s3.push("second, sha3-512");
      // Either Stash reads either entry: the read keys on the entry's OWN stored algo,
      // never the reader's option.
      assert.ok((await s256.show(a)).digest.startsWith("sha256:"));
      assert.ok((await s256.show(b)).digest.startsWith("sha3-512:"));
      assert.deepEqual(await drain(await s256.apply(b)), Buffer.from("second, sha3-512"), "a sha256-configured Stash still verifies a sha3-512 entry");
      assert.deepEqual(await drain(await s3.apply(a)), Buffer.from("first, sha256"));
      assert.deepEqual((await s256.verify()).findings, [], "the mixed-algorithm store verifies clean");
    });

    test("store() replicates an entry with its OWN algorithm intact (self-describing)", async () => {
      const stash = new Stash({ backend: create() }); // default sha256 for its own pushes
      const id = generate();
      const bytes = "replicated under sha3-512";
      const entry = makeStoredEntry(id, bytes, { digest: digestOf(bytes, "sha3-512") });
      assert.equal(await stash.store(entry, bytes), true, "the sha3-512 entry lands");
      assert.equal((await stash.show(id)).digest, digestOf(bytes, "sha3-512"), "its algorithm is preserved, not rewritten to sha256");
      assert.deepEqual(await drain(await stash.apply(id)), Buffer.from(bytes));
    });

    test("a corrupted read under a non-sha256 digest errors with IntegrityError (verified with the STORED algo, not sha256)", async () => {
      const inner = create();
      const corrupting = corruptingReadBackend(inner);
      const stash = new Stash({ backend: corrupting, digest: "sha3-512" });
      const ref = await stash.push("original bytes");
      await assert.rejects(drain(await stash.apply(ref)), (e) => e instanceof IntegrityError && e.code === "EINTEGRITY");
    });

    test("store() rejects a digest with an UNKNOWN algorithm and a known algo with the WRONG hex length -> IntegrityError, nothing lands", async () => {
      const stash = new Stash({ backend: create() });
      const bytes = "x";
      const unknownAlgo = makeStoredEntry(generate(), bytes, { digest: "md5:" + "0".repeat(32) });
      await assert.rejects(stash.store(unknownAlgo, bytes), IntegrityError);
      const wrongLen = makeStoredEntry(generate(), bytes, { digest: "sha512:" + "0".repeat(64) }); // sha512 needs 128 hex
      await assert.rejects(stash.store(wrongLen, bytes), IntegrityError);
      assert.deepEqual(await stash.list(), [], "not one malformed-digest entry landed");
    });

    test("the digest option is a closed enum: an unknown or non-string algorithm is a config-time TypeError; every registry algorithm constructs", () => {
      assert.throws(() => new Stash({ backend: create(), digest: "md5" }), TypeError);
      assert.throws(() => new Stash({ backend: create(), digest: 42 }), TypeError);
      for (const algo of DIGEST_ALGOS) assert.doesNotThrow(() => new Stash({ backend: create(), digest: algo }));
    });

    test("a backend built to the DOCUMENTED write(id, source, entry) signature still honors the digest selection -- it rides in the entry, not an extra argument", async () => {
      // A custom backend written to the SPEC.md 9 three-argument contract cannot see a
      // positional arg beyond `entry`. If the chosen algorithm were threaded as a
      // fourth write() argument, such a backend would silently drop it and hash with
      // the default -- an operator asking for sha3-512 would get sha256 with no error.
      // The selection must travel inside the entry the backend is already handed.
      const inner = create();
      const documented = wrapBackend(inner, { write: (id, source, entry) => inner.write(id, source, entry) });
      const stash = new Stash({ backend: documented, digest: "sha3-512" });
      const ref = await stash.push("bytes under a strictly-three-arg backend");
      assert.ok((await stash.show(ref)).digest.startsWith("sha3-512:"), "the sha3-512 selection survived a three-argument backend");
      assert.deepEqual(await drain(await stash.apply(ref)), Buffer.from("bytes under a strictly-three-arg backend"), "and the entry still verifies");
    });
  });
}

suite("ref validation precedes storage access", () => {
  function probe() {
    const calls = [];
    const inner = new MemoryBackend();
    const backend = {};
    for (const method of BACKEND_METHODS) {
      backend[method] = (...args) => {
        calls.push(method);
        return inner[method](...args);
      };
    }
    return { backend, calls };
  }

  test("a traversal ref throws InvalidRef with zero backend calls", async () => {
    const { backend, calls } = probe();
    const stash = new Stash({ backend });
    for (const hostile of ["../../etc/passwd", "v1_..", "/abs/path", "v1_%2e%2e"]) {
      await assert.rejects(stash.apply(hostile), InvalidRef);
      await assert.rejects(stash.show(hostile), InvalidRef);
      await assert.rejects(stash.drop(hostile), InvalidRef);
      // store()'s replicated entry is ref-shaped input too: its id must clear the
      // whitelist BEFORE #recover() (which lists claims and can restore/burn stale
      // ones -- mutating backend I/O) ever runs. store is the one ref-consuming verb
      // that used to invert this, scanning the backend before validating the id.
      await assert.rejects(stash.store({ id: hostile }, "bytes"), InvalidRef);
    }
    assert.deepEqual(calls, []);
  });
});

suite("integrity", () => {
  test("a corrupted blob errors the apply stream with IntegrityError", async () => {
    // A backend whose read path returns bytes that no longer match the
    // digest it recorded -- the storage-rot case the verifying stream exists
    // to catch.
    const inner = new MemoryBackend();
    const corrupting = corruptingReadBackend(inner);
    const stash = new Stash({ backend: corrupting });
    const ref = await stash.push("original bytes");
    const readable = await stash.apply(ref);
    await assert.rejects(drain(readable), (err) => err instanceof IntegrityError && err.code === "EINTEGRITY");
  });

  test("verification is streaming: chunks arrive before the verdict", async () => {
    const stash = new Stash({ backend: new MemoryBackend() });
    const payload = Buffer.alloc(64 * 1024, 7);
    const ref = await stash.push(payload);
    const readable = await stash.apply(ref);
    let sawChunkBeforeEnd = false;
    readable.on("data", () => {
      sawChunkBeforeEnd = true;
    });
    await new Promise((resolve, reject) => {
      readable.on("end", resolve);
      readable.on("error", reject);
    });
    assert.equal(sawChunkBeforeEnd, true);
  });
});

suite("config-time failures", () => {
  test("a Stash without a usable backend refuses to construct", () => {
    assert.throws(() => new Stash(), TypeError);
    assert.throws(() => new Stash({}), TypeError);
    assert.throws(() => new Stash({ backend: null }), TypeError);
    assert.throws(() => new Stash({ backend: { write() {} } }), TypeError);
  });

  test("an unknown constructor option is a config-time TypeError (every spec'd option now ships)", () => {
    // tombstoneTtl -- the last spec'd-but-unimplemented option -- landed with M7, so
    // the reject-unimplemented mechanism retired; the option surface is complete.
    assert.throws(() => new Stash({ backend: new MemoryBackend(), unknownKnob: 1 }), TypeError);
    // tombstoneTtl is now ACCEPTED (its enforcement vectors live in the M7 suite).
    assert.doesNotThrow(() => new Stash({ backend: new MemoryBackend(), tombstoneTtl: "1h" }));
  });

  test("pop options are validated at construction: onPopFailure enum, claimTimeout duration, reads a positive integer", async () => {
    const B = () => new MemoryBackend();
    // onPopFailure is a closed enum (vector 27).
    for (const bad of ["explode", 42, ""]) {
      assert.throws(() => new Stash({ backend: B(), onPopFailure: bad }), TypeError);
    }
    new Stash({ backend: B(), onPopFailure: "restore" });
    new Stash({ backend: B(), onPopFailure: "burn" });
    // claimTimeout is a POSITIVE duration; a NaN threshold is a silently-disabled
    // scan, and 0 would make recovery reclaim an active pop instantly (vector 28).
    for (const bad of ["ten minutes", -1, 0, NaN, {}]) {
      assert.throws(() => new Stash({ backend: B(), claimTimeout: bad }), TypeError);
    }
    new Stash({ backend: B(), claimTimeout: "10m" });
    new Stash({ backend: B(), claimTimeout: 60000 });
    new Stash({ backend: B(), claimTimeout: 1 });
    // reads is a positive integer or null, validated at make() during push (vector 29).
    const stash = new Stash({ backend: B() });
    for (const bad of [0, -1, 1.5, "3", Infinity]) {
      await assert.rejects(stash.push("x", { reads: bad }), TypeError);
    }
    assert.match(await stash.push("a", { reads: 1 }), /^v1_/);
    assert.match(await stash.push("b", { reads: null }), /^v1_/);
  });

  test("limit bounds are validated at construction (an unvalidated bound is a disabled check)", () => {
    // maxSize / maxTotal: a size string or positive byte count. Zero, negative,
    // fractional, malformed strings, and non-size values are config errors --
    // reaching a `count > bound` compare with any of them fails open or fails
    // everything.
    for (const bad of [0, -1, NaN, Infinity, 1.5, "0mb", "1.5mb", "mb", "10h", "100", true, {}, []]) {
      assert.throws(() => new Stash({ backend: new MemoryBackend(), maxSize: bad }), TypeError);
      assert.throws(() => new Stash({ backend: new MemoryBackend(), maxTotal: bad }), TypeError);
    }
    // maxEntries is a positive integer count with no string form.
    for (const bad of [0, -1, 1.5, NaN, Infinity, "100", "10mb", true, {}]) {
      assert.throws(() => new Stash({ backend: new MemoryBackend(), maxEntries: bad }), TypeError);
    }
    // valid bounds construct without throwing (maxSize within maxTotal)
    new Stash({ backend: new MemoryBackend(), maxSize: "100mb", maxTotal: "1gb", maxEntries: 10 });
  });

  test("maxSize above maxTotal is a config-time TypeError (a per-entry cap that can never bind)", () => {
    // An empty store admits at most maxTotal bytes, so a maxSize larger than
    // maxTotal is a cap that never fires -- surface the contradiction at boot,
    // not as silent dead configuration.
    assert.throws(() => new Stash({ backend: new MemoryBackend(), maxSize: 100, maxTotal: 50 }), TypeError);
    assert.throws(() => new Stash({ backend: new MemoryBackend(), maxSize: "2gb", maxTotal: "1gb" }), TypeError);
    // equal is coherent (an entry of exactly maxTotal fits an empty store), and
    // either bound alone imposes no cross-constraint.
    new Stash({ backend: new MemoryBackend(), maxSize: 50, maxTotal: 50 });
    new Stash({ backend: new MemoryBackend(), maxSize: 100 });
    new Stash({ backend: new MemoryBackend(), maxTotal: 50 });
  });

  test("push rejects a non-object opts and unknown options", async () => {
    const stash = new Stash({ backend: new MemoryBackend() });
    await assert.rejects(stash.push("x", null), TypeError);
    await assert.rejects(stash.push("x", { unknown: true }), TypeError);
    await assert.rejects(stash.push("x", { meta: "not an object" }), TypeError);
    await assert.rejects(stash.push("x", { meta: [] }), TypeError);
  });

  test("push rejects sources outside the documented set", async () => {
    const stash = new Stash({ backend: new MemoryBackend() });
    for (const source of [42, null, undefined, {}, [Buffer.from("x")], () => {}]) {
      await assert.rejects(stash.push(source), TypeError);
    }
    // nothing was stored by any refused push
    assert.deepEqual(await stash.list(), []);
  });

  test("stash errors are distinguishable from config errors", async () => {
    const stash = new Stash({ backend: new MemoryBackend() });
    await assert.rejects(stash.apply("bogus"), (err) => err instanceof StashError);
    await assert.rejects(stash.push("x", { unknown: true }), (err) => !(err instanceof StashError));
  });
});
