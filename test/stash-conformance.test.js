// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// The backend conformance suite. Every backend runs the same cases through
// the shipped consumer path (new Stash({ backend })); a new backend joins
// by adding a factory to BACKENDS.
import { after, suite, test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { Stash, RefNotFound, InvalidRef, IntegrityError, StashError } from "../src/index.js";
import { MemoryBackend } from "../src/backends/memory.js";
import { DiskBackend } from "../src/backends/disk.js";
import { generate } from "../src/ref.js";
import { C } from "../src/constants.js";
import { freshScratchDir, cleanupScratch } from "./_scratch.js";

// The sandbox denies spawn; the process-exits vector needs a child process, so
// it skips there (its scaffolding, not the library, needs the capability).
const SANDBOXED = typeof process.permission !== "undefined";

// pollUntil(fn) -- resolve once fn() is truthy, reject on timeout. The
// drift-rule-6b wait: poll a condition for an event, never sleep a fixed span.
// (A fixed passive window appears only to prove the ABSENCE of an event.)
async function pollUntil(fn, { timeout = 3000, step = 5 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error("pollUntil timed out");
    await new Promise((r) => setTimeout(r, step));
  }
}

after(() => cleanupScratch());

const BACKENDS = [
  { name: "memory", create: () => new MemoryBackend() },
  { name: "disk", create: () => new DiskBackend({ root: freshScratchDir("conf") }) },
];

async function drain(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(chunk);
  return Buffer.concat(chunks);
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
      for (const m of ["write", "read", "remove", "stat", "list"]) {
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
        write: (...a) => inner.write(...a),
        stat: (...a) => inner.stat(...a),
        remove: (...a) => inner.remove(...a),
        list: (...a) => inner.list(...a),
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

    test("apply's expiry re-check tolerates an already-closed read source: still drops, no leak", async () => {
      // The dispose helper guards a source that is null, not a stream, or
      // already destroyed -- a backend can legitimately hand one back. Drive
      // that branch: a lapsing entry whose read() returns an already-destroyed
      // stream still drops and rejects, without re-destroying or hanging.
      const inner = create();
      const backend = {
        write: (...a) => inner.write(...a),
        stat: (...a) => inner.stat(...a),
        remove: (...a) => inner.remove(...a),
        list: (...a) => inner.list(...a),
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
        write: (...a) => inner.write(...a),
        stat: (...a) => inner.stat(...a),
        remove: (...a) => inner.remove(...a),
        list: (...a) => inner.list(...a),
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
        write: (...a) => inner.write(...a),
        stat: (...a) => inner.stat(...a),
        remove: (...a) => inner.remove(...a),
        list: (...a) => inner.list(...a),
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
  });
}

suite("clear under concurrent destruction", () => {
  test("an entry that vanishes between list and remove is not counted", async () => {
    // A remove that reports false mid-clear models a concurrent drop --
    // the count is actual destructions, not the length of the listing.
    const inner = new MemoryBackend();
    let vanish = null;
    const backend = {
      write: (...args) => inner.write(...args),
      read: (...args) => inner.read(...args),
      stat: (...args) => inner.stat(...args),
      list: (...args) => inner.list(...args),
      remove: async (id) => {
        if (id === vanish) {
          vanish = null;
          await inner.remove(id);
          return false; // someone else already destroyed it
        }
        return inner.remove(id);
      },
    };
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
      write: (...a) => inner.write(...a),
      read: (...a) => inner.read(...a),
      stat: (...a) => inner.stat(...a),
      list: (...a) => inner.list(...a),
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
      write: (...a) => inner.write(...a),
      read: (...a) => inner.read(...a),
      stat: (...a) => inner.stat(...a),
      remove: (...a) => inner.remove(...a),
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
      write: (...a) => inner.write(...a),
      read: (...a) => inner.read(...a),
      stat: (...a) => inner.stat(...a),
      remove: (...a) => inner.remove(...a),
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
      write: (...a) => inner.write(...a),
      read: (...a) => inner.read(...a),
      stat: (...a) => inner.stat(...a),
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
  });
}

suite("ref validation precedes storage access", () => {
  function probe() {
    const calls = [];
    const inner = new MemoryBackend();
    const backend = {};
    for (const method of ["write", "read", "remove", "stat", "list"]) {
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
    const corrupting = {
      write: (...args) => inner.write(...args),
      stat: (...args) => inner.stat(...args),
      remove: (...args) => inner.remove(...args),
      list: (...args) => inner.list(...args),
      read: async (id) => {
        await inner.read(id);
        return Readable.from([Buffer.from("tampered bytes")]);
      },
    };
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

  test("spec options whose milestone has not shipped throw, never sit unenforced", () => {
    const backend = new MemoryBackend();
    for (const key of ["maxSize", "maxEntries", "maxTotal", "onPopFailure", "tombstoneTtl", "claimTimeout"]) {
      assert.throws(() => new Stash({ backend, [key]: "1h" }), TypeError);
    }
    assert.throws(() => new Stash({ backend: new MemoryBackend(), unknownKnob: 1 }), TypeError);
  });

  test("push rejects unimplemented and unknown options", async () => {
    const stash = new Stash({ backend: new MemoryBackend() });
    await assert.rejects(stash.push("x", null), TypeError);
    await assert.rejects(stash.push("x", { reads: 3 }), TypeError);
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
    await assert.rejects(stash.push("x", { reads: 3 }), (err) => !(err instanceof StashError));
  });
});
