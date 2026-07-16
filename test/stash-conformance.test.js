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
import { freshScratchDir, cleanupScratch } from "./_scratch.js";

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
    for (const key of ["ttl", "maxSize", "maxEntries", "maxTotal", "onPopFailure", "tombstoneTtl", "sweepInterval", "claimTimeout"]) {
      assert.throws(() => new Stash({ backend, [key]: "1h" }), TypeError);
    }
    assert.throws(() => new Stash({ backend: new MemoryBackend(), unknownKnob: 1 }), TypeError);
  });

  test("push rejects unimplemented and unknown options", async () => {
    const stash = new Stash({ backend: new MemoryBackend() });
    await assert.rejects(stash.push("x", null), TypeError);
    await assert.rejects(stash.push("x", { ttl: "1h" }), TypeError);
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
    await assert.rejects(stash.push("x", { ttl: "1h" }), (err) => !(err instanceof StashError));
  });
});
