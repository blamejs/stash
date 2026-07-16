// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Disk-specific vectors: the sidecar layout, atomic writes, containment,
// and the hostile-sidecar battery. The shared behavior contract lives in
// stash-conformance.test.js and runs against this backend unmodified.
import { after, suite, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { Stash, RefNotFound, InvalidRef, IntegrityError } from "../src/index.js";
import { DiskBackend } from "../src/backends/disk.js";
import { generate } from "../src/ref.js";
import { freshScratchDir, cleanupScratch } from "./_scratch.js";

function freshRoot() {
  return freshScratchDir("disk");
}
after(() => cleanupScratch());

// Windows grants file-symlink creation only to elevated / developer-mode
// sessions; junctions work for directories everywhere. Probe once so the
// symlink vectors run wherever the platform allows and skip loudly where
// it does not (CI's Linux runner always runs them).
function canSymlinkFiles() {
  const probeDir = freshScratchDir("symlink-probe");
  mkdirSync(probeDir, { recursive: true });
  const target = join(probeDir, "target");
  const link = join(probeDir, "link");
  writeFileSync(target, "x");
  try {
    symlinkSync(target, link, "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}
const FILE_SYMLINKS = canSymlinkFiles();

// Under --permission the runtime denies fs.symlink entirely, so the
// vectors that PLANT links (the library only ever refuses them) run in
// the unsandboxed suite and in CI; the sandboxed pass proves the library
// itself, not the test scaffolding.
const SANDBOXED = typeof process.permission !== "undefined";

async function drain(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function freshStash() {
  const root = freshRoot();
  return { root, stash: new Stash({ backend: new DiskBackend({ root }) }) };
}

suite("disk: construction", () => {
  test("root is validated at config time; the constructor does no I/O", () => {
    assert.throws(() => new DiskBackend(), TypeError);
    assert.throws(() => new DiskBackend({}), TypeError);
    assert.throws(() => new DiskBackend({ root: 42 }), TypeError);
    assert.throws(() => new DiskBackend({ root: "" }), TypeError);
    assert.throws(() => new DiskBackend({ root: freshRoot(), unknown: 1 }), TypeError);
    const root = freshRoot();
    new DiskBackend({ root });
    assert.equal(existsSync(root), false); // lazy init: nothing until first op
  });
});

suite("disk: layout and atomicity", () => {
  test("sidecar layout appears on first use, one blob + one sidecar per entry", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("laid out");
    for (const dir of ["blobs", "meta", "claims", "tombstones"]) {
      assert.equal(existsSync(join(root, dir)), true);
    }
    assert.deepEqual(readdirSync(join(root, "blobs")), [ref]);
    assert.deepEqual(readdirSync(join(root, "meta")), [ref + ".json"]);
    const sidecar = JSON.parse(readFileSync(join(root, "meta", ref + ".json"), "utf8"));
    assert.equal(sidecar.id, ref);
  });

  test("a failed push leaves nothing behind -- no tmp, no blob, no sidecar", async () => {
    const { root, stash } = freshStash();
    async function* explodes() {
      yield Buffer.from("first chunk");
      throw new Error("source died");
    }
    await assert.rejects(stash.push(explodes()), /source died/);
    assert.deepEqual(readdirSync(join(root, "blobs")), []);
    assert.deepEqual(readdirSync(join(root, "meta")), []);
  });

  test("a stray blob without a sidecar is invisible; a stray tmp is never served", async () => {
    const { root, stash } = freshStash();
    await stash.push("real entry");
    const orphan = generate();
    writeFileSync(join(root, "blobs", orphan), "crash leftover");
    writeFileSync(join(root, "blobs", generate() + ".tmp"), "partial");
    assert.equal((await stash.list()).length, 1);
    await assert.rejects(stash.show(orphan), RefNotFound);
    await assert.rejects(stash.apply(orphan), RefNotFound);
  });

  test("a sidecar without its blob is corruption, not silence", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("half entry");
    rmSync(join(root, "blobs", ref));
    await assert.rejects(stash.apply(ref), (err) => err instanceof IntegrityError && err.code === "EINTEGRITY");
  });

  test("a directory squatting where a blob should be is corruption", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("blob displaced");
    rmSync(join(root, "blobs", ref));
    mkdirSync(join(root, "blobs", ref));
    await assert.rejects(stash.apply(ref), IntegrityError);
  });

  test("a directory squatting where a sidecar should be is corruption", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("sidecar displaced");
    rmSync(join(root, "meta", ref + ".json"));
    mkdirSync(join(root, "meta", ref + ".json"));
    await assert.rejects(stash.show(ref), IntegrityError);
  });

  test("a vanished layout directory is damage, not absence", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("was here");
    rmSync(join(root, "meta"), { recursive: true, force: true });
    await assert.rejects(stash.show(ref), (err) => err instanceof IntegrityError);
  });

  test("meta too large for a sidecar is refused at push, blob cleaned up", async () => {
    const { root, stash } = freshStash();
    await assert.rejects(
      stash.push("padded", { meta: { pad: "x".repeat(96 * 1024) } }),
      TypeError
    );
    assert.deepEqual(readdirSync(join(root, "blobs")), []);
  });

  test("a push whose blob rename cannot land cleans up its tmp and rejects", async () => {
    // The source blocks the final rename by squatting a directory at the
    // blob's destination (any EPERM/EISDIR at rename lands here -- an AV
    // hold or a planted obstacle behaves the same). The push must reject
    // AND remove the .tmp partial: a failed push leaves nothing behind.
    const { root, stash } = freshStash();
    async function* saboteur() {
      yield Buffer.from("first");
      const tmp = readdirSync(join(root, "blobs")).find((n) => n.endsWith(".tmp"));
      mkdirSync(join(root, "blobs", tmp.slice(0, -".tmp".length)));
      yield Buffer.from("second");
    }
    await assert.rejects(stash.push(saboteur()));
    assert.equal(readdirSync(join(root, "blobs")).some((n) => n.endsWith(".tmp")), false);
    assert.deepEqual(readdirSync(join(root, "meta")), []);
    assert.deepEqual(await stash.list(), []);
  });

  test("a push whose sidecar rename cannot land cleans up blob and sidecar tmp and rejects", async () => {
    const { root, stash } = freshStash();
    async function* saboteur() {
      yield Buffer.from("first");
      const tmp = readdirSync(join(root, "blobs")).find((n) => n.endsWith(".tmp"));
      mkdirSync(join(root, "meta", tmp.slice(0, -".tmp".length) + ".json"));
      yield Buffer.from("second");
    }
    await assert.rejects(stash.push(saboteur()));
    assert.equal(readdirSync(join(root, "meta")).some((n) => n.endsWith(".tmp")), false);
    assert.deepEqual(readdirSync(join(root, "blobs")), []);
    // the planted obstacle itself still reads as damage -- loud, not lossy
    await assert.rejects(stash.list(), IntegrityError);
  });

  test("a sidecar write that cannot land removes the blob and rethrows", async () => {
    const { root, stash } = freshStash();
    // the source itself sabotages the meta dir mid-stream: the blob lands,
    // the sidecar cannot, and the failed push leaves nothing served
    async function* saboteur() {
      yield Buffer.from("bytes");
      rmSync(join(root, "meta"), { recursive: true, force: true });
    }
    await assert.rejects(stash.push(saboteur()));
    assert.deepEqual(readdirSync(join(root, "blobs")), []);
  });

  test("an uncreatable root rejects every operation, and retries stay honest", async () => {
    const scratchFile = freshScratchDir("rootfile");
    writeFileSync(scratchFile, "a file, not a directory");
    const stash = new Stash({ backend: new DiskBackend({ root: join(scratchFile, "sub") }) });
    await assert.rejects(stash.push("nowhere"));
    await assert.rejects(stash.push("still nowhere")); // init retried, failed again, no poisoned memo
  });

  // root reads straight through a 000 mode, so this vector needs an
  // unprivileged POSIX user -- exactly what CI's runner is.
  const CANNOT_FAULT = process.platform === "win32" ||
    (typeof process.getuid === "function" && process.getuid() === 0);

  test("a filesystem fault that is not absence propagates loudly", { skip: CANNOT_FAULT }, async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("guarded");
    const { chmodSync } = await import("node:fs");
    chmodSync(join(root, "meta"), 0o000);
    try {
      await stash.show(ref).then(
        () => assert.fail("expected a loud fault"),
        (err) => assert.equal(err.code, "EACCES") // the OS fault, not a swallowed default
      );
    } finally {
      chmodSync(join(root, "meta"), 0o700);
    }
  });

  test("entries persist across backend instances over the same root", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("durable bytes", { meta: { kind: "note" } });
    const reopened = new Stash({ backend: new DiskBackend({ root }) });
    const entry = await reopened.show(ref);
    assert.equal(entry.meta.kind, "note");
    assert.equal((await drain(await reopened.apply(ref))).toString("utf8"), "durable bytes");
  });
});

suite("disk: containment", () => {
  test("traversal ids die at the backend boundary with no path built", async () => {
    const backend = new DiskBackend({ root: freshRoot() });
    for (const hostile of ["../../etc/passwd", "..\\..\\evil", "/abs", "v1_..", "v1_" + "A".repeat(42) + "/"]) {
      await assert.rejects(backend.stat(hostile), InvalidRef);
      await assert.rejects(backend.read(hostile), InvalidRef);
      await assert.rejects(backend.remove(hostile), InvalidRef);
    }
  });

  test("a symlink where a blob should be is corruption, not a blob", { skip: !FILE_SYMLINKS }, async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("legitimate");
    const outside = freshScratchDir("outside-file");
    writeFileSync(outside, "secret outside the root");
    rmSync(join(root, "blobs", ref));
    symlinkSync(outside, join(root, "blobs", ref), "file");
    await assert.rejects(stash.apply(ref), IntegrityError);
    // the target's bytes were never followed into a stream
  });

  test("a subdirectory swapped for a link out of the root is refused", { skip: SANDBOXED }, async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("first"); // materializes the layout
    const outside = freshScratchDir("outside-dir");
    mkdirSync(outside, { recursive: true });
    rmSync(join(root, "blobs"), { recursive: true, force: true });
    // junction: works unelevated on Windows; plain dir symlink elsewhere
    symlinkSync(outside, join(root, "blobs"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(stash.apply(ref), (err) => err instanceof InvalidRef || err instanceof IntegrityError);
    await assert.rejects(stash.push("escapes"), (err) => err instanceof InvalidRef || err instanceof IntegrityError);
  });

  test("blob files are 0600 and directories 0700", { skip: process.platform === "win32" }, async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("modes");
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, "blobs")).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, "blobs", ref)).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "meta", ref + ".json")).mode & 0o777, 0o600);
  });
});

suite("disk: hostile sidecars", () => {
  async function corrupted(mutate) {
    const { root, stash } = freshStash();
    const ref = await stash.push("victim", { meta: { k: "v" } });
    const sidecarPath = join(root, "meta", ref + ".json");
    const original = JSON.parse(readFileSync(sidecarPath, "utf8"));
    writeFileSync(sidecarPath, mutate(original, ref));
    return { stash, ref };
  }

  const MUTATIONS = [
    ["not JSON at all", () => "{ not json"],
    ["truncated JSON", (o) => JSON.stringify(o).slice(0, 25)],
    ["an array", () => "[]"],
    ["empty object", () => "{}"],
    ["null", () => "null"],
    ["id of a different entry", (o) => JSON.stringify({ ...o, id: generate() })],
    ["id not ref-shaped", (o) => JSON.stringify({ ...o, id: "not-a-ref" })],
    ["field swapped for an unknown one", (o) => {
      const c = { ...o, impostor: 1 };
      delete c.digest;
      return JSON.stringify(c);
    }],
    ["size as a string", (o) => JSON.stringify({ ...o, size: "big" })],
    ["negative size", (o) => JSON.stringify({ ...o, size: -1 })],
    ["missing digest", (o) => { const c = { ...o }; delete c.digest; return JSON.stringify(c); }],
    ["digest not sha256 hex", (o) => JSON.stringify({ ...o, digest: "sha256:xyz" })],
    ["unknown extra field", (o) => JSON.stringify({ ...o, extra: 1 })],
    ["meta not an object", (o) => JSON.stringify({ ...o, meta: "flat" })],
    ["createdAt not an integer", (o) => JSON.stringify({ ...o, createdAt: 1.5 })],
    ["expiresAt not null or an integer", (o) => JSON.stringify({ ...o, expiresAt: "tomorrow" })],
    ["reads without readsLeft", (o) => JSON.stringify({ ...o, reads: 3 })],
    ["zero reads budget", (o) => JSON.stringify({ ...o, reads: 0, readsLeft: 0 })],
    ["readsLeft above reads", (o) => JSON.stringify({ ...o, reads: 2, readsLeft: 3 })],
    ["negative readsLeft", (o) => JSON.stringify({ ...o, reads: 2, readsLeft: -1 })],
    ["oversized sidecar", (o) => JSON.stringify({ ...o, meta: { pad: "x".repeat(96 * 1024) } })],
  ];

  for (const [name, mutate] of MUTATIONS) {
    test("sidecar corruption is a typed verdict: " + name, async () => {
      const { stash, ref } = await corrupted(mutate);
      await assert.rejects(stash.show(ref), (err) => err instanceof IntegrityError && err.code === "EINTEGRITY");
      await assert.rejects(stash.apply(ref), IntegrityError);
    });
  }

  test("a sidecar carrying future-milestone terms is accepted, not rejected", async () => {
    // Expiry (M3) and budgets (M5) travel WITH the entry; a store written
    // by a newer line must stay readable here as long as the shape holds.
    const { root, stash } = freshStash();
    const ref = await stash.push("terms ahead");
    const sidecarPath = join(root, "meta", ref + ".json");
    const original = JSON.parse(readFileSync(sidecarPath, "utf8"));
    writeFileSync(sidecarPath, JSON.stringify({
      ...original,
      expiresAt: original.createdAt + 1000,
      reads: 3,
      readsLeft: 2,
    }));
    const entry = await stash.show(ref);
    assert.equal(entry.expiresAt, original.createdAt + 1000);
    assert.equal(entry.reads, 3);
    assert.equal(entry.readsLeft, 2);
  });

  test("list() is loud, not lossy, over a corrupt sidecar", async () => {
    const { stash } = await corrupted(() => "{ rot }");
    await assert.rejects(stash.list(), IntegrityError);
  });

  test("list() skips an in-flight sidecar tmp and refuses foreign files", async () => {
    const { root, stash } = freshStash();
    await stash.push("legitimate");
    writeFileSync(join(root, "meta", generate() + ".json.tmp"), "{");
    assert.equal((await stash.list()).length, 1); // in-flight tmp is invisible
    writeFileSync(join(root, "meta", "AAAA.json"), "{}");
    await assert.rejects(stash.list(), IntegrityError); // a foreign name is damage
  });

  test("no corruption verdict ever names the ref or a path", async () => {
    const { stash, ref } = await corrupted(() => "{ rot }");
    await stash.show(ref).then(
      () => assert.fail("expected rejection"),
      (err) => {
        assert.equal(err.message.includes(ref), false);
        assert.doesNotMatch(err.message, /[\\/]/);
      }
    );
  });
});
