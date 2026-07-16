// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Disk-specific vectors: the sidecar layout, atomic writes, containment,
// and the hostile-sidecar battery. The shared behavior contract lives in
// stash-conformance.test.js and runs against this backend unmodified.
import { after, suite, test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { Stash, RefNotFound, InvalidRef, IntegrityError, SizeExceeded } from "../src/index.js";
import { DiskBackend, descriptorMatchesName, verifyDescriptorAgainstName } from "../src/backends/disk.js";
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

// A FIFO (named pipe) planted where a blob or sidecar belongs is the FIFO
// vector: on POSIX an O_RDONLY open of a FIFO with no writer parks forever.
// mkfifo is POSIX-only and unprivileged (Windows has neither the command
// nor the parking semantics; the sandbox denies the spawn that creates
// one), so probe once and skip where it is unavailable.
function canMkfifo() {
  if (process.platform === "win32") return false;
  const probeDir = freshScratchDir("fifo-probe");
  mkdirSync(probeDir, { recursive: true });
  try {
    execFileSync("mkfifo", [join(probeDir, "p")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}
const FIFO_OK = canMkfifo();

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

  // Rot on the stored blob file itself -- every shape must die as a typed
  // stream verdict, never as silently wrong bytes.
  const BLOB_CORRUPTIONS = [
    ["bit-flipped", (p) => {
      const bytes = readFileSync(p);
      bytes[0] ^= 0x01;
      writeFileSync(p, bytes);
    }],
    ["truncated", (p) => truncateSync(p, 3)],
    ["extended", (p) => appendFileSync(p, "xx")],
  ];

  for (const [name, corrupt] of BLOB_CORRUPTIONS) {
    test("a " + name + " blob file errors the apply stream with IntegrityError", async () => {
      const { root, stash } = freshStash();
      const ref = await stash.push("victim bytes for corruption");
      corrupt(join(root, "blobs", ref));
      await assert.rejects(
        drain(await stash.apply(ref)),
        (err) => err instanceof IntegrityError && err.code === "EINTEGRITY"
      );
    });
  }

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

  test("a lazy expiry drop that cannot delete surfaces the OS fault, not RefNotFound", { skip: CANNOT_FAULT }, async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("expired but locked", { ttl: 0 });
    const { chmodSync } = await import("node:fs");
    // read+exec but no write: stat reads the sidecar, but the lazy drop's unlink
    // in the meta dir fails. SPEC 2.1: the denial surfaces, never degrades into
    // a swallowed not-found.
    chmodSync(join(root, "meta"), 0o500);
    try {
      await stash.apply(ref).then(
        () => assert.fail("expected the lazy drop's EACCES to surface"),
        (err) => assert.equal(err.code, "EACCES")
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

  test("expiry policy binds across backend instances over the same root", async () => {
    const { root, stash: writer } = freshStash();
    const ref = await writer.push("expired at birth", { ttl: 0 });
    const reopened = new Stash({ backend: new DiskBackend({ root }) });
    // the reopened instance re-derives expiresAt from the sidecar: the policy
    // binds without the writer in memory. Before any read verb, list hides it
    // and includeExpired reveals it.
    assert.deepEqual(await reopened.list(), []);
    assert.equal((await reopened.list({ includeExpired: true })).length, 1);
    // a read verb applies the policy and drops it in passing
    await assert.rejects(reopened.apply(ref), (err) => err instanceof RefNotFound && err.code === "ENOREF");
    assert.equal((await reopened.list({ includeExpired: true })).length, 0);
    assert.deepEqual(readdirSync(join(root, "meta")), []);
    assert.deepEqual(readdirSync(join(root, "blobs")), []);
  });

  test("list tolerates a sidecar removed between readdir and stat (concurrent sweep/drop)", async () => {
    // The sweeper (or a concurrent drop) can unlink an expired sidecar between
    // the readdir and the per-entry stat, so stat throws RefNotFound for a name
    // readdir just reported. That entry has simply left the listing -- list must
    // not reject. Reproduced deterministically: unlink one sidecar the instant
    // its stat is reached.
    const { root, stash } = freshStash();
    const vanishing = await stash.push("removed mid-scan");
    const kept = await stash.push("survives the scan");
    const backend = new DiskBackend({ root });
    const realStat = backend.stat.bind(backend);
    let removeOnStat = vanishing;
    backend.stat = async (id) => {
      if (id === removeOnStat) {
        removeOnStat = null;
        rmSync(join(root, "meta", id + ".json")); // a concurrent removal, mid-scan
      }
      return realStat(id);
    };
    const listed = await backend.list();
    assert.deepEqual(listed.map((e) => e.id), [kept]); // the vanished entry is absent, not an error
  });

  test("list still fails loudly on a corrupt sidecar, never silently skipped", async () => {
    // The RefNotFound skip must not swallow corruption: a rotten sidecar is an
    // IntegrityError the listing surfaces.
    const { root, stash } = freshStash();
    const ref = await stash.push("to be corrupted");
    writeFileSync(join(root, "meta", ref + ".json"), "{ not valid json");
    const backend = new DiskBackend({ root });
    await assert.rejects(backend.list(), IntegrityError);
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

  // The containment check of a directory must gate the write INTO it, not a
  // moment far earlier. A blob streams for as long as its source runs; if
  // the meta directory is resolved and verified before that stream begins
  // but the sidecar is written only after it ends, an attacker who swaps
  // meta for a link out of the root DURING the stream writes the sidecar
  // outside the pinned root -- the check passed on the pre-swap directory,
  // the write landed on the post-swap one. The source here performs that
  // swap mid-stream, so the sidecar write must re-assert containment and
  // refuse, never land a file in the outside directory.
  test("the meta dir is contained at the sidecar write, not before the blob stream", { skip: SANDBOXED }, async () => {
    const { root, stash } = freshStash();
    await stash.push("materialize the layout");
    const outside = freshScratchDir("outside-meta");
    mkdirSync(outside, { recursive: true });

    async function* swapsMetaMidStream() {
      yield Buffer.from("chunk one");
      // between the early containment check and the late sidecar write
      rmSync(join(root, "meta"), { recursive: true, force: true });
      symlinkSync(outside, join(root, "meta"), process.platform === "win32" ? "junction" : "dir");
      yield Buffer.from("chunk two");
    }

    await assert.rejects(
      stash.push(swapsMetaMidStream()),
      (err) => err instanceof InvalidRef || err instanceof IntegrityError
    );
    // the sidecar never followed the swapped link into the outside directory
    assert.deepEqual(readdirSync(outside), []);
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

suite("disk: fd-based read discipline (CWE-367)", () => {
  const O_NOFOLLOW_AVAILABLE = (constants.O_NOFOLLOW || 0) !== 0;
  const POSIX_LINKS = FILE_SYMLINKS && O_NOFOLLOW_AVAILABLE;

  // A direct reproduction of the time-of-check/time-of-use window the fix
  // closes. The old shape checked a path (lstat) and then handed the SAME
  // path to a second read: a symlink swapped in between the check and the
  // read is re-resolved when the read opens it, and followed out of the
  // root. The fixed shape opens a descriptor with O_NOFOLLOW and reads THAT
  // handle -- the swap cannot redirect a read bound to an open fd.
  test("a path re-resolved after its check follows a swapped symlink; O_NOFOLLOW refuses it", { skip: !POSIX_LINKS }, async () => {
    const dir = freshScratchDir("toctou");
    mkdirSync(dir, { recursive: true });
    const guarded = join(dir, "sidecar.json");
    writeFileSync(guarded, JSON.stringify({ trusted: true }));

    const outsideDir = freshScratchDir("toctou-outside");
    mkdirSync(outsideDir, { recursive: true });
    const secret = join(outsideDir, "secret");
    writeFileSync(secret, "BYTES OUTSIDE THE ROOT");

    // check: the name is a regular file (what the removed lstat saw)
    assert.equal(lstatSync(guarded).isFile(), true);
    // an attacker with write access to the directory swaps it for a symlink
    rmSync(guarded);
    symlinkSync(secret, guarded, "file");

    // re-resolving the path (the old readFile(path)) FOLLOWS the swap:
    assert.equal(readFileSync(guarded, "utf8"), "BYTES OUTSIDE THE ROOT");

    // opening a descriptor with O_NOFOLLOW refuses the symlink outright, so
    // a read bound to that descriptor can never be redirected:
    await assert.rejects(
      open(guarded, constants.O_RDONLY | constants.O_NOFOLLOW),
      (err) => err.code === "ELOOP"
    );
  });

  // A blob or sidecar replaced with a FIFO (named pipe) that has no writer
  // would park an O_RDONLY open forever -- before the fstat that rejects a
  // non-regular shape can run -- hanging show / list / apply instead of
  // failing. The non-blocking open returns at once so the fstat refuses the
  // FIFO as damage. Each test carries its own timeout: a regression parks
  // the test itself (a failure), never the shared runner.
  test("a FIFO where a sidecar belongs is refused promptly, never blocks", { skip: !FIFO_OK || SANDBOXED, timeout: 10000 }, async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("legit", { meta: { k: "v" } });
    const sidecarPath = join(root, "meta", ref + ".json");
    rmSync(sidecarPath);
    execFileSync("mkfifo", [sidecarPath]);
    await assert.rejects(stash.show(ref), IntegrityError);
    await assert.rejects(stash.list(), IntegrityError);
  });

  test("a FIFO where a blob belongs is refused promptly, never blocks", { skip: !FIFO_OK || SANDBOXED, timeout: 10000 }, async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("legit blob");
    const blobPath = join(root, "blobs", ref);
    rmSync(blobPath);
    execFileSync("mkfifo", [blobPath]);
    await assert.rejects(stash.apply(ref), IntegrityError);
  });

  // The no-follow guard for a platform WITHOUT O_NOFOLLOW (Windows): the
  // open follows a swapped symlink, so a post-open lstat of the NAME is a
  // check of its own -- an attacker who swaps the symlink for a regular
  // in-root file between the open and the lstat passes an isSymbolicLink
  // check while the descriptor stays bound to the outside target. The fix
  // binds the verdict to the descriptor's identity (fstat) against the
  // name's current identity (no-follow lstat); these vectors pin that
  // comparison's contract directly, so they hold on every platform
  // regardless of symlink-creation privilege.
  test("descriptorMatchesName: an untampered regular file matches (fstat == lstat, not a link)", () => {
    const stat = { dev: 42, ino: 1001, isSymbolicLink: () => false };
    assert.equal(descriptorMatchesName(stat, stat), true);
  });

  test("descriptorMatchesName: a symlinked name is refused even when dev+ino coincide", () => {
    const opened = { dev: 42, ino: 1001, isSymbolicLink: () => false };
    const named = { dev: 42, ino: 1001, isSymbolicLink: () => true };
    assert.equal(descriptorMatchesName(opened, named), false);
  });

  test("descriptorMatchesName: a swap after open (different ino) is refused", () => {
    // fstat: the object the open bound (the outside symlink target);
    // lstat: the regular in-root file swapped in afterward. Same device,
    // different inode -> the descriptor no longer speaks for the name.
    const opened = { dev: 42, ino: 1001, isSymbolicLink: () => false };
    const swappedIn = { dev: 42, ino: 2002, isSymbolicLink: () => false };
    assert.equal(descriptorMatchesName(opened, swappedIn), false);
  });

  test("descriptorMatchesName: a cross-device identity is refused (different dev)", () => {
    const opened = { dev: 42, ino: 1001, isSymbolicLink: () => false };
    const otherVolume = { dev: 99, ino: 1001, isSymbolicLink: () => false };
    assert.equal(descriptorMatchesName(opened, otherVolume), false);
  });

  // verifyDescriptorAgainstName -- the lstat-after-open orchestration that only
  // runs on a platform without O_NOFOLLOW (dead on Linux, where O_NOFOLLOW
  // refuses a symlink at the open itself). Driven directly so every branch --
  // the match, the swap mismatch, the vanished name, and a non-absence lstat
  // fault -- is pinned on EVERY platform, with no symlink-creation privilege.
  test("verifyDescriptorAgainstName: a name resolving to the open descriptor passes", async () => {
    const dir = freshScratchDir("vd-ok");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "f");
    writeFileSync(p, "bytes");
    const fh = await open(p, "r");
    try {
      await verifyDescriptorAgainstName(await fh.stat(), p, "damaged"); // resolves, no throw
    } finally {
      await fh.close();
    }
  });

  test("verifyDescriptorAgainstName: a name resolving to a different object is refused", async () => {
    const dir = freshScratchDir("vd-swap");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a");
    writeFileSync(a, "a");
    const b = join(dir, "b");
    writeFileSync(b, "b");
    const fh = await open(a, "r");
    try {
      // the descriptor is a's; the name b lstats to a different inode
      await assert.rejects(verifyDescriptorAgainstName(await fh.stat(), b, "damaged"), IntegrityError);
    } finally {
      await fh.close();
    }
  });

  test("verifyDescriptorAgainstName: a name that vanished after the open is IntegrityError", async () => {
    const dir = freshScratchDir("vd-gone");
    mkdirSync(dir, { recursive: true });
    const gone = join(dir, "never-created");
    const openedStat = { dev: 1, ino: 1, isSymbolicLink: () => false };
    await assert.rejects(verifyDescriptorAgainstName(openedStat, gone, "damaged"), IntegrityError);
  });

  // A path under a regular file is ENOTDIR on POSIX but ENOENT on Windows
  // (which reports it as plain absence), so the non-absence branch is exercised
  // on POSIX -- where CI runs. The absence branch above is portable.
  test("verifyDescriptorAgainstName: a non-absence lstat fault propagates, not swallowed", { skip: process.platform === "win32" }, async () => {
    const dir = freshScratchDir("vd-fault");
    mkdirSync(dir, { recursive: true });
    const asFile = join(dir, "file");
    writeFileSync(asFile, "x");
    const underFile = join(asFile, "child"); // ENOTDIR on POSIX -- a non-absence lstat fault
    const openedStat = { dev: 1, ino: 1, isSymbolicLink: () => false };
    await assert.rejects(verifyDescriptorAgainstName(openedStat, underFile, "damaged"),
      (err) => err.code === "ENOTDIR" && !(err instanceof IntegrityError));
  });

  // Shipped path: a symlinked sidecar is refused, never followed to
  // attacker-chosen metadata -- on POSIX at open (O_NOFOLLOW), and on a
  // platform without the flag by the post-open lstat guard.
  test("a symlinked sidecar is refused, never followed to foreign metadata", { skip: !FILE_SYMLINKS }, async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("legit", { meta: { k: "v" } });
    const sidecarPath = join(root, "meta", ref + ".json");
    const foreign = freshScratchDir("foreign-sidecar");
    const original = JSON.parse(readFileSync(sidecarPath, "utf8"));
    // a shape-valid sidecar for the same id, but with metadata the attacker
    // chose -- exactly what following the symlink would substitute in
    writeFileSync(foreign, JSON.stringify({ ...original, meta: { injected: true } }));
    rmSync(sidecarPath);
    symlinkSync(foreign, sidecarPath, "file");
    await assert.rejects(stash.show(ref), IntegrityError);
    await assert.rejects(stash.apply(ref), IntegrityError);
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

suite("disk: limits (SPEC.md 8)", () => {
  test("an oversized push leaves no blob, sidecar, or .tmp on disk", async () => {
    const { root } = freshStash();
    const stash = new Stash({ backend: new DiskBackend({ root }), maxSize: 16 });
    await assert.rejects(stash.push(Buffer.alloc(32, 1)), SizeExceeded);
    assert.deepEqual(readdirSync(join(root, "blobs")), []);
    assert.deepEqual(readdirSync(join(root, "meta")), []);
  });

  test("an oversized hostile source stops at the boundary; the tmp never absorbs the tail", async () => {
    const { root } = freshStash();
    const stash = new Stash({ backend: new DiskBackend({ root }), maxSize: 64 });
    let pulled = 0;
    async function* hostile() {
      for (;;) { pulled += 1; yield Buffer.alloc(16, 1); } // 4x maxSize in 16-byte chunks
    }
    await assert.rejects(stash.push(hostile()), SizeExceeded);
    assert.ok(pulled <= 5, "pulls bounded near ceil(maxSize/chunk) -- the check is before the yield (pulled " + pulled + ")");
    assert.deepEqual(readdirSync(join(root, "blobs")), []);
  });

  test("stats() sums the sidecar count and blob sizes, and fails loudly on a foreign name in meta/", async () => {
    const { root, stash } = freshStash();
    await stash.push(Buffer.alloc(10, 1));
    await stash.push(Buffer.alloc(5, 2));
    const backend = new DiskBackend({ root });
    const s = await backend.stats();
    assert.equal(s.entries, 2);
    assert.ok(s.bytes > 15, "footprint counts the two sidecar files on top of the 15 blob bytes");
    assert.equal(s.claimed, 0);
    // a foreign name in meta/ is corruption, surfaced the same way list() does
    writeFileSync(join(root, "meta", "intruder.json"), "{}");
    await assert.rejects(backend.stats(), IntegrityError);
  });
});
