// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// The backend conformance suite. Every backend runs the same cases through
// the shipped consumer path (new Stash({ backend })); a new backend joins
// by adding a factory to BACKENDS.
import { suite, test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { Stash, RefNotFound, InvalidRef, IntegrityError, StashError } from "../src/index.js";
import { MemoryBackend } from "../src/backends/memory.js";
import { generate } from "../src/ref.js";

const BACKENDS = [
  { name: "memory", create: () => new MemoryBackend() },
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
