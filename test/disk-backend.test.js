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
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { Stash, RefNotFound, RefClaimed, InvalidRef, IntegrityError, SizeExceeded } from "../src/index.js";
import { DiskBackend, descriptorMatchesName, verifyDescriptorAgainstName, _writeAll } from "../src/backends/disk.js";
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

// chmod-000 does not deny access on win32 (modes are advisory) nor to root
// (which bypasses permission bits), so the verify-FAULT vector skips there and
// runs on CI's unprivileged Linux runner.
const CANNOT_FAULT = process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0);

async function drain(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function freshStash() {
  const root = freshRoot();
  return { root, stash: new Stash({ backend: new DiskBackend({ root }) }) };
}

// Older than the default '10m' claimTimeout: a claim stamped this far back reads
// as a prior run's abandoned pop, not a live one.
const CLAIM_STALE_MS = 20 * 60 * 1000;

// Plant the on-disk state a crashed pop leaves behind. A real claim hard-links
// blobs/<id> into claims/<id> then unlinks the original, so the net state is the
// blob living only under claims/<id>; its mtime is claimedAt (what recovery reads
// to age the claim). A stale mtime is a prior run's abandoned pop; a fresh one
// (ageMs: 0) is another live process's. The sidecar stays in meta/ unless
// `dropSidecar` simulates a commit interrupted after the sidecar unlink.
// renameSync of a just-written blob can EPERM briefly on Windows while the OS
// still holds the closed handle (antivirus / indexer / lazy release); POSIX
// renames on the first try. A bounded retry with a short synchronous pause
// clears it. Test-only robustness -- the shipped backend has its own retry.
function _renameSyncRetry(from, to) {
  const spin = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (err.code !== "EPERM" || attempt >= 50) throw err;
      Atomics.wait(spin, 0, 0, 4); // ~4ms synchronous pause before the next attempt
    }
  }
}

function plantClaim(root, ref, { ageMs = CLAIM_STALE_MS, dropSidecar = false } = {}) {
  _renameSyncRetry(join(root, "blobs", ref), join(root, "claims", ref));
  const when = new Date(Date.now() - ageMs);
  utimesSync(join(root, "claims", ref), when, when);
  if (dropSidecar) rmSync(join(root, "meta", ref + ".json"));
}

// A child that takes a real claim then SIGKILLs itself mid-pop, leaving the
// actual on-disk crash state (blob under claims/, sidecar intact) the planted
// vectors simulate. It imports the library by absolute URL so it resolves from
// anywhere; it signals readiness by writing the ref only AFTER pop has claimed.
const RECOVER_CHILD = [
  `import { Stash } from ${JSON.stringify(new URL("../src/index.js", import.meta.url).href)};`,
  `import { DiskBackend } from ${JSON.stringify(new URL("../src/backends/disk.js", import.meta.url).href)};`,
  `import { writeFileSync } from "node:fs";`,
  `const [root, refFile] = process.argv.slice(2);`,
  `const stash = new Stash({ backend: new DiskBackend({ root }) });`,
  `const ref = await stash.push(Buffer.alloc(65536, 3));`,
  `await stash.pop(ref);`, // claim taken: blob moved to claims/, stream never drained
  `writeFileSync(refFile, ref);`, // tell the parent the claim is in place
  `process.kill(process.pid, "SIGKILL");`, // die mid-pop, claim abandoned
  ``,
].join("\n");

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

  test("stats() counts an entry only when its sidecar is present, in step with list()", async () => {
    // stats() stats each sidecar BEFORE counting it, so `entries` matches what
    // list() reports: a sidecar removed by a concurrent sweep is skipped, never
    // counted as a zero-byte entry (the same tolerance list() holds against a
    // sidecar that vanishes between the readdir and the per-entry read). A blob
    // removed under a surviving sidecar still counts the entry, at its sidecar
    // size alone.
    const { root, stash } = freshStash();
    await stash.push(Buffer.alloc(10, 1));
    const b = await stash.push(Buffer.alloc(5, 2));
    rmSync(join(root, "blobs", b)); // blob gone, sidecar survives
    const backend = new DiskBackend({ root });
    const s = await backend.stats();
    const listed = await backend.list();
    assert.equal(s.entries, 2, "both sidecars present -> both counted");
    assert.equal(s.entries, listed.length, "stats().entries agrees with list().length");
    assert.ok(s.bytes > 10, "counts one intact blob plus both sidecars, minus the removed blob");
  });
});

suite("disk: crash recovery (SPEC 6)", () => {
  test("an abandoned claim restores on the first op, not at construction (default policy)", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("survivor");
    plantClaim(root, ref); // a prior run killed mid-pop: stale claim, sidecar intact
    const next = new Stash({ backend: new DiskBackend({ root }) });
    assert.equal(existsSync(join(root, "claims", ref)), true, "the constructor performed no scan");
    assert.deepEqual(await drain(await next.apply(ref)), Buffer.from("survivor"), "the first op restored it");
    assert.equal(existsSync(join(root, "claims", ref)), false, "the resolved claim is gone");
    assert.equal(existsSync(join(root, "blobs", ref)), true, "the blob is live under blobs/ again");
  });

  test("an abandoned claim burns under onPopFailure:'burn', leaving no residue", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("condemned");
    plantClaim(root, ref);
    const next = new Stash({ backend: new DiskBackend({ root }), onPopFailure: "burn" });
    await assert.rejects(next.apply(ref), RefNotFound);
    for (const dir of ["blobs", "meta", "claims"]) {
      assert.deepEqual(readdirSync(join(root, dir)), [], `${dir}/ holds no residue`);
    }
  });

  test("a FRESH claim is left alone -- another process's live pop is not resolved out from under it", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("in-flight");
    plantClaim(root, ref, { ageMs: 0 }); // claimedAt = now -> a live pop, not this run's to resolve
    const next = new Stash({ backend: new DiskBackend({ root }) });
    await assert.rejects(next.apply(ref), RefClaimed); // recovery left it; the reader sees the live claim
    assert.equal(existsSync(join(root, "claims", ref)), true, "the live claim is untouched");
  });

  test("an interrupted commit is finished, never restored -- a claim without a sidecar is completed", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("half-deleted");
    plantClaim(root, ref, { dropSidecar: true }); // the sidecar was already unlinked: commit was interrupted
    const next = new Stash({ backend: new DiskBackend({ root }) });
    await assert.rejects(next.apply(ref), RefNotFound);
    for (const dir of ["blobs", "meta", "claims"]) {
      assert.deepEqual(readdirSync(join(root, dir)), [], `${dir}/ emptied -- the deletion finished`);
    }
  });

  test("a read debit survives a crash between the debit and the restore -- exactly the remaining budget serves", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("twice", { reads: 2 });
    // The window between consumeRead (sidecar already decremented) and restore
    // (blob still claimed): a crash here must leave the debit persisted, so the
    // entry serves its REMAINING credit, never the pre-debit count.
    const sidecar = join(root, "meta", ref + ".json");
    const entry = JSON.parse(readFileSync(sidecar, "utf8"));
    entry.readsLeft = 1;
    writeFileSync(sidecar, JSON.stringify(entry));
    plantClaim(root, ref);
    const next = new Stash({ backend: new DiskBackend({ root }) });
    assert.deepEqual(await drain(await next.apply(ref)), Buffer.from("twice"), "the surviving credit serves");
    await assert.rejects(next.apply(ref), RefNotFound, "one credit remained and is now spent -- not two");
  });

  test("a planted symlink at claims/<id> is never followed off the store", { skip: !FILE_SYMLINKS }, async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("real");
    const secret = join(freshRoot(), "outside");
    mkdirSync(join(secret, ".."), { recursive: true });
    writeFileSync(secret, "attacker-controlled");
    rmSync(join(root, "blobs", ref)); // clear the real blob, plant a link in its claimed place
    symlinkSync(secret, join(root, "claims", ref), "file");
    // lutimes, not utimes: stamp the LINK's own mtime (utimes would follow it and
    // age the target) so recovery reads the claim as stale and resolves it.
    const when = new Date(Date.now() - CLAIM_STALE_MS);
    lutimesSync(join(root, "claims", ref), when, when);
    const next = new Stash({ backend: new DiskBackend({ root }) });
    // recovery restores by RENAME (the link is moved, never dereferenced); the
    // read then refuses the symlinked blob rather than serving foreign bytes.
    await assert.rejects(next.apply(ref), IntegrityError);
    assert.equal(readFileSync(secret, "utf8"), "attacker-controlled", "the link target was never touched");
  });

  test("file modes survive a claim/restore cycle: the restored blob is still 0600", { skip: process.platform === "win32" }, async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push(Buffer.alloc(65536, 1), { reads: 2 });
    await drain(await stash.apply(ref)); // a budgeted read: claim -> consumeRead -> restore
    assert.equal(statSync(join(root, "blobs", ref)).mode & 0o777, 0o600, "the restored blob keeps 0600");
  });

  test("a drop during a live claim is monotone -- restoring the abandoned claim resurrects nothing", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("condemned");
    plantClaim(root, ref, { ageMs: 0 }); // a live claim: the blob sits in claims/, the sidecar in meta/
    await stash.drop(ref); // drop mid-claim removes the sidecar -- the entry is destroyed
    assert.equal(existsSync(join(root, "meta", ref + ".json")), false, "the sidecar is gone");
    // The claim-holder (or a later run) tries to restore the abandoned claim. A
    // dropped entry MUST NOT come back, and no orphan blob may be left behind
    // (SPEC 4.2 monotone) -- the same contract the memory backend's remove states.
    const backend = new DiskBackend({ root });
    await assert.rejects(backend.restore(ref), RefNotFound, "restore of a dropped entry finds nothing");
    for (const dir of ["blobs", "meta", "claims"]) {
      assert.deepEqual(readdirSync(join(root, dir)), [], `${dir}/ empty -- no orphan, no resurrection`);
    }
  });

  test("a process killed mid-pop leaves a claim the next construction recovers", { skip: SANDBOXED || process.platform === "win32", timeout: 15000 }, async () => {
    const root = freshRoot();
    const bay = freshScratchDir("recover-child");
    mkdirSync(bay, { recursive: true });
    const refFile = join(bay, "ref");
    const childFile = join(bay, "child.mjs");
    writeFileSync(childFile, RECOVER_CHILD);
    // The child SIGKILLs itself after claiming, so execFileSync throws on the
    // signal exit -- that throw IS the crash under test.
    let died = false;
    try {
      execFileSync(process.execPath, [childFile, root, refFile], { stdio: "ignore" });
    } catch {
      died = true;
    }
    assert.ok(died, "the child self-terminated mid-pop");
    const ref = readFileSync(refFile, "utf8").trim();
    assert.equal(existsSync(join(root, "claims", ref)), true, "the kill left the blob claimed in claims/");
    assert.equal(existsSync(join(root, "blobs", ref)), false, "blobs/ is empty -- the claim took the blob");
    // A fresh construction recovers the abandoned claim on its first op. The
    // real kill happened many ms ago (execFileSync blocked for the child's whole
    // life), so a 1ms claimTimeout reads it as stale; the default policy restores.
    const next = new Stash({ backend: new DiskBackend({ root }), claimTimeout: 1 });
    assert.deepEqual(await drain(await next.apply(ref)), Buffer.alloc(65536, 3), "the killed pop's entry recovered and served");
  });

  test("recovery tolerates a claim another instance's start already resolved -- no spurious failure", async () => {
    // Two Stash instances over one root can list the same stale claim before
    // either resolves it. A one-shot side effect on stat plays the racing
    // instance here: it restores the claim in the window between this recovery's
    // listClaims and its own restore, so the loser's restore finds blobs/<id>
    // already occupied (IntegrityError) with the claim gone. Recovery must read
    // that as concurrent COMPLETION -- no stale claim remains -- and let the
    // now-live entry serve, never abort the loser's first operation.
    const { root, stash } = freshStash();
    const ref = await stash.push("survivor");
    plantClaim(root, ref); // stale claim, sidecar intact
    const inner = new DiskBackend({ root });
    let raced = false;
    const backend = {};
    for (const m of ["write", "read", "remove", "stat", "list", "stats", "verify", "claim", "restore", "commit", "listClaims", "consumeRead", "isClaimed"]) {
      backend[m] = (...a) => inner[m](...a);
    }
    backend.stat = async (id) => {
      const entry = await inner.stat(id);
      if (!raced) { raced = true; await inner.restore(id); } // the racing instance restores it first
      return entry;
    };
    const loser = new Stash({ backend });
    assert.deepEqual(
      await drain(await loser.apply(ref)),
      Buffer.from("survivor"),
      "the already-recovered entry serves; a concurrent restore is completion, not failure",
    );
  });

  test("recovery completes an interrupted claim (crash after link, before unlink) -- a duplicate link, not a brick", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("survivor");
    // The crash window: the blob is hard-linked into claims/ but the original
    // blobs/ name was never removed -- both names point at one blob. Stamp the
    // claim stale so recovery acts.
    linkSync(join(root, "blobs", ref), join(root, "claims", ref));
    const when = new Date(Date.now() - CLAIM_STALE_MS);
    lutimesSync(join(root, "claims", ref), when, when);
    // restore must recognize blobs/<id> as the SAME inode (the interrupted claim),
    // drop the redundant claim, and keep the entry live -- not brick every op with
    // a "target occupied" IntegrityError recovery can never clear.
    const next = new Stash({ backend: new DiskBackend({ root }) });
    assert.deepEqual(await drain(await next.apply(ref)), Buffer.from("survivor"), "the interrupted-claim entry recovered and serves");
    assert.equal(existsSync(join(root, "claims", ref)), false, "the redundant claim name was dropped");
    assert.equal(existsSync(join(root, "blobs", ref)), true, "the entry stays live at blobs/");
  });

  test("prune alone recovers stale claims -- a sweep-only deployment resolves an abandoned pop", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("survivor");
    plantClaim(root, ref); // stale claim, sidecar intact
    // prune is the ONLY operation a sweep-only deployment runs; it must carry the
    // first-operation recovery, resolving the stale claim rather than deferring it
    // until some other verb happens to run.
    const next = new Stash({ backend: new DiskBackend({ root }) });
    await next.prune();
    assert.equal(existsSync(join(root, "claims", ref)), false, "prune recovered the stale claim");
    assert.deepEqual(await drain(await next.apply(ref)), Buffer.from("survivor"), "the recovered entry is live");
  });

  test("recovery re-runs after the grace period -- a claim young at the first op is reclaimed once it ages, no restart", { timeout: 5000 }, async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("survivor");
    plantClaim(root, ref, { ageMs: 0 }); // a fresh claim: younger than the lease at the first op
    const next = new Stash({ backend: new DiskBackend({ root }), claimTimeout: 50 });
    await assert.rejects(next.apply(ref), RefClaimed); // the first op leaves the young claim alone
    // Once the claim ages past the 50ms lease, a LATER op must re-run recovery and
    // restore it -- without a restart. Poll that later op (memoizing recovery
    // forever would spin here until the test times out).
    let bytes;
    for (;;) {
      try { bytes = await drain(await next.apply(ref)); break; }
      catch (err) {
        if (!(err instanceof RefClaimed)) throw err;
        await new Promise((r) => setImmediate(r));
      }
    }
    assert.deepEqual(bytes, Buffer.from("survivor"), "recovery re-ran after the grace period and the entry serves");
  });
});

suite("disk: drop races the claim lifecycle (SPEC 4.2)", () => {
  const skeleton = (id, reads) => ({
    id, size: 0, digest: null, createdAt: 0, expiresAt: null, reads, readsLeft: reads, meta: {},
  });

  test("consumeRead rewrites the sidecar in place, never via a fresh file", { skip: process.platform === "win32" }, async () => {
    // The debit rewrites the sidecar THROUGH the descriptor it read -- same inode
    // -- not a tmp+rename that installs a new one. That is what keeps the debit
    // safe against a concurrent drop: a rename recreates a name the drop removed
    // (resurrection), while an in-place write lands on the same inode, or on a
    // ghost if the name was unlinked. Inode identity is the observable proof.
    const { root } = freshStash();
    const backend = new DiskBackend({ root });
    const id = generate();
    await backend.write(id, [Buffer.alloc(100, 1)], skeleton(id, 2));
    (await backend.claim(id)).source.destroy();
    const sidecar = join(root, "meta", id + ".json");
    const before = statSync(sidecar).ino;
    assert.equal(await backend.consumeRead(id), 1);
    assert.equal(statSync(sidecar).ino, before, "the sidecar keeps its inode -- rewritten in place, not replaced");
  });

  test("consumeRead of an entry whose sidecar was dropped refuses and recreates nothing", async () => {
    const { root } = freshStash();
    const backend = new DiskBackend({ root });
    const id = generate();
    await backend.write(id, [Buffer.alloc(100, 1)], skeleton(id, 2));
    (await backend.claim(id)).source.destroy();
    rmSync(join(root, "meta", id + ".json")); // a concurrent drop removed the sidecar
    await assert.rejects(backend.consumeRead(id), RefNotFound);
    assert.deepEqual(readdirSync(join(root, "meta")), [], "the debit never recreated the dropped sidecar");
  });

  test("restore of an entry whose sidecar was dropped refuses and leaves no orphan blob", async () => {
    const { root } = freshStash();
    const backend = new DiskBackend({ root });
    const id = generate();
    await backend.write(id, [Buffer.alloc(100, 1)], skeleton(id, 2));
    (await backend.claim(id)).source.destroy();
    rmSync(join(root, "meta", id + ".json")); // a concurrent drop removed the sidecar
    await assert.rejects(backend.restore(id), RefNotFound);
    assert.deepEqual(readdirSync(join(root, "blobs")), [], "no blob orphaned in blobs/ without a sidecar");
    assert.deepEqual(readdirSync(join(root, "meta")), [], "the sidecar stays gone -- not resurrected");
  });

  test("a claim over a symlinked blob never follows the link to touch an outside target", { skip: !FILE_SYMLINKS }, async () => {
    // A hostile blobs/<id> symlink is hard-linked into claims/ as a link to the
    // symlink. A path utimes would FOLLOW it and stamp the target's mtime outside
    // the store before the open rejects the claim -- bending the no-follow
    // discipline. lutimes stamps the link itself, so the target is never touched
    // and the claim still fails loudly at the open.
    const { root } = freshStash();
    const backend = new DiskBackend({ root });
    const id = generate();
    await backend.write(id, [Buffer.alloc(100, 1)], skeleton(id, 2));
    const outside = freshRoot();
    mkdirSync(outside, { recursive: true });
    const target = join(outside, "outside-target");
    writeFileSync(target, "attacker-owned");
    const targetMtimeBefore = statSync(target).mtimeMs;
    rmSync(join(root, "blobs", id));
    symlinkSync(target, join(root, "blobs", id), "file"); // swap the blob for a link out of the store
    await assert.rejects(backend.claim(id), IntegrityError);
    assert.equal(statSync(target).mtimeMs, targetMtimeBefore, "the outside target's mtime was not touched");
  });

  test("writeAll writes the whole buffer under short writes, and fails on no progress", async () => {
    // FileHandle.write can resolve after fewer than length bytes; a truncated
    // sidecar or blob reads back as corruption and loses a completed drain's
    // budget. writeAll must loop until the buffer is fully written.
    const payload = Buffer.from("the full serialized sidecar payload, longer than one short write");
    const landed = Buffer.alloc(payload.length);
    let calls = 0;
    const shortFh = {
      write: async (buf, off, len, pos) => {
        calls += 1;
        const n = Math.min(3, len); // pathological: at most three bytes per call
        buf.copy(landed, pos, off, off + n);
        return { bytesWritten: n };
      },
    };
    await _writeAll(shortFh, payload, 0);
    assert.deepEqual(landed, payload, "every byte landed despite three-byte short writes");
    assert.ok(calls > 1, "the write actually looped over the short writes");
    // a write that makes no progress is a fault, not an infinite loop
    const stuckFh = { write: async () => ({ bytesWritten: 0 }) };
    await assert.rejects(_writeAll(stuckFh, payload, 0), IntegrityError);
  });

  test("stats() counts a sidecar-less claim blob's bytes so a drop-during-claim cannot bypass maxTotal", async () => {
    // pop/read + drop + abandon leaves a blob under claims/ with no sidecar in
    // meta/. Those bytes still occupy the store, so stats() must count them --
    // otherwise repeating the sequence hoards claim blobs that every bounded push
    // sees as an empty store, a maxTotal bypass and a disk-fill.
    const { root } = freshStash();
    const backend = new DiskBackend({ root });
    const id = generate();
    await backend.write(id, [Buffer.alloc(5000, 1)], skeleton(id, 2));
    (await backend.claim(id)).source.destroy(); // blob -> claims/, sidecar in meta/
    rmSync(join(root, "meta", id + ".json")); // a drop removes the sidecar; the blob lingers in claims/
    const s = await backend.stats();
    assert.equal(s.entries, 0, "no live entry -- the sidecar is gone");
    assert.equal(s.claimed, 1, "the claim is counted");
    assert.ok(s.bytes >= 5000, "the sidecar-less claim blob's bytes count against the store footprint");
  });

  test("a claim whose sidecar was dropped after the blob moved cleans up, never orphans", async () => {
    // The claim links+unlinks the blob into claims/ THEN stats the sidecar; a drop
    // that removes the sidecar in that window makes stat RefNotFound. The claim
    // must undo itself -- not strand the blob in claims/ where it blocks later
    // reads and holds maxTotal until a future run's recovery.
    const { root } = freshStash();
    const backend = new DiskBackend({ root });
    const id = generate();
    await backend.write(id, [Buffer.alloc(100, 1)], skeleton(id, 2));
    rmSync(join(root, "meta", id + ".json")); // the entry is dropped before the claim's stat
    await assert.rejects(backend.claim(id), RefNotFound);
    assert.deepEqual(readdirSync(join(root, "claims")), [], "the dropped entry's blob is not orphaned in claims/");
  });

  test("a claim that fails on a corrupt sidecar after the blob moved restores it, never orphans", async () => {
    const { root } = freshStash();
    const backend = new DiskBackend({ root });
    const id = generate();
    await backend.write(id, [Buffer.alloc(100, 1)], skeleton(id, 2));
    writeFileSync(join(root, "meta", id + ".json"), "{ not valid json"); // stat throws IntegrityError post-move
    await assert.rejects(backend.claim(id), IntegrityError);
    assert.deepEqual(readdirSync(join(root, "claims")), [], "no orphan claim left behind");
    assert.equal(existsSync(join(root, "blobs", id)), true, "the blob was restored to blobs/, its pre-claim state");
  });

  test("a budgeted read racing a concurrent drop leaves no resurrection and no orphan half", async () => {
    // Sweep the finalize window many rounds: a drop removing the sidecar while a
    // reads:2 apply debits-and-restores must keep the entry destroyed -- never a
    // recreated sidecar (resurrection) nor a sidecar-less blob stranded in blobs/
    // (an unreclaimable orphan). A blob may linger in claims/ pending recovery.
    for (let round = 0; round < 40; round += 1) {
      const { root, stash } = freshStash();
      const ref = await stash.push(Buffer.alloc(65536, round % 256), { reads: 2 });
      const reader = (async () => {
        try { await drain(await stash.apply(ref)); } catch { /* raced: RefNotFound / RefClaimed / IntegrityError are all fine */ }
      })();
      const dropper = stash.drop(ref).catch(() => {});
      await Promise.all([reader, dropper]);
      assert.deepEqual(readdirSync(join(root, "meta")), [], `round ${round}: no sidecar survives a dropped entry`);
      assert.deepEqual(readdirSync(join(root, "blobs")), [], `round ${round}: no blob orphaned in blobs/`);
    }
  });
});

suite("disk: verify -- the physical-integrity audit (SPEC.md 4, 12)", () => {
  const bp = (root, ref) => join(root, "blobs", ref);
  const mp = (root, ref) => join(root, "meta", ref + ".json");
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  test("THE DONE-WHEN: a bit-flipped blob, a stale orphan .tmp, and a meta-without-blob report (dry) then repair, a healthy entry surviving", async () => {
    const { root, stash } = freshStash();
    const flipped = await stash.push(Buffer.alloc(64, 7));   // (a) will be bit-flipped
    const missing = await stash.push("no blob here");        // (c) meta-without-blob
    const healthy = await stash.push("survivor");
    const buf = readFileSync(bp(root, flipped)); buf[0] ^= 0xff; writeFileSync(bp(root, flipped), buf);
    const tmp = join(root, "blobs", "orphan.tmp"); writeFileSync(tmp, "half a push"); // (b) stale orphan tmp
    const old = new Date(Date.now() - TWO_HOURS); utimesSync(tmp, old, old);
    rmSync(bp(root, missing));

    const dry = await stash.verify();
    assert.deepEqual(dry.findings.map((f) => f.kind).sort(), ["digest-mismatch", "missing-blob", "orphan-tmp"]);
    assert.deepEqual(dry.repaired, [], "dry run touches nothing");
    assert.ok(existsSync(bp(root, flipped)) && existsSync(mp(root, missing)) && existsSync(tmp), "every planted file still on disk");

    const rep = await stash.verify({ repair: true });
    assert.equal(rep.repaired.length, 3, "all three condemned");
    assert.ok(!existsSync(bp(root, flipped)) && !existsSync(mp(root, flipped)), "the digest-mismatch pair (blob+sidecar) removed together");
    assert.ok(!existsSync(mp(root, missing)), "the missing-blob sidecar removed");
    assert.ok(!existsSync(tmp), "the orphan .tmp removed");
    assert.deepEqual(await drain(await stash.apply(healthy)), Buffer.from("survivor"), "the healthy survivor round-trips byte-identical");
  });

  test("a FRESH .tmp is not condemned -- an in-flight push is spared (CWE-367)", async () => {
    const { root, stash } = freshStash();
    await stash.push("real");
    const tmp = join(root, "blobs", "inflight.tmp"); writeFileSync(tmp, "being written"); // mtime = now
    const rep = await stash.verify({ repair: true });
    assert.deepEqual(rep.repaired, [], "a fresh tmp is never repaired");
    assert.equal(existsSync(tmp), true, "the in-flight tmp is untouched");
  });

  test("an AGED blob without a sidecar is orphan-blob, removed only under repair", async () => {
    const { root, stash } = freshStash();
    await stash.push("keep");
    const orphan = generate(); writeFileSync(bp(root, orphan), "orphaned bytes");
    const old = new Date(Date.now() - TWO_HOURS); utimesSync(bp(root, orphan), old, old); // aged past the grace -> a genuine orphan
    const dry = await stash.verify();
    assert.deepEqual(dry.findings, [{ kind: "orphan-blob", id: orphan }]);
    assert.equal(existsSync(bp(root, orphan)), true, "the dry run leaves it");
    await stash.verify({ repair: true });
    assert.equal(existsSync(bp(root, orphan)), false, "repair removes the orphan blob");
  });

  test("a FRESH sidecarless blob is SPARED -- write() renames blob->final BEFORE the sidecar, so it may be an in-flight push (CWE-367)", async () => {
    const { root, stash } = freshStash();
    await stash.push("keep");
    // A blob with its final name and NO sidecar looks identical to a push caught
    // between the blob rename and the sidecar write. Condemning a fresh one would
    // delete the just-written blob and leave a live push a corrupt sidecar-only
    // entry. It gets the same grace an in-flight .tmp does; a later verify past the
    // grace reaps it if it truly is an orphan.
    const fresh = generate(); writeFileSync(bp(root, fresh), "just landed"); // mtime = now
    const dry = await stash.verify();
    assert.deepEqual(dry.findings, [], "a fresh sidecarless blob is not condemned");
    const rep = await stash.verify({ repair: true });
    assert.deepEqual(rep.repaired, [], "repair spares it too");
    assert.equal(existsSync(bp(root, fresh)), true, "the possibly-in-flight blob is untouched");
  });

  test("a foreign file is foreign-file with id: null; no filename or path separator leaks into the report", async () => {
    const { root, stash } = freshStash();
    await stash.push("legit");
    writeFileSync(join(root, "meta", "AAAA.json"), "{}");
    writeFileSync(join(root, "blobs", "not-a-ref"), "x");
    const report = await stash.verify();
    const foreign = report.findings.filter((f) => f.kind === "foreign-file");
    assert.equal(foreign.length, 2);
    assert.ok(foreign.every((f) => f.id === null), "a foreign name is never a ref");
    const json = JSON.stringify(report);
    assert.equal(json.includes("AAAA"), false, "the foreign filename is not echoed");
    assert.equal(json.includes("not-a-ref"), false);
    assert.equal(json.includes("/"), false, "no path separator leaks");
    assert.equal(json.includes("\\"), false);
  });

  test("a corrupt sidecar is corrupt-sidecar (verify does not throw); repair removes sidecar and blob", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("valid");
    writeFileSync(mp(root, ref), "{ not valid json");
    const dry = await stash.verify(); // corruption is verify's SUBJECT -- it reports, never throws
    assert.deepEqual(dry.findings, [{ kind: "corrupt-sidecar", id: ref }]);
    await stash.verify({ repair: true });
    assert.ok(!existsSync(mp(root, ref)) && !existsSync(bp(root, ref)), "sidecar and blob both removed");
  });

  test("drop over a CORRUPT sidecar still removes it -- drop reads nothing, so corruption never blocks cleanup", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("valid");
    writeFileSync(mp(root, ref), "{ not valid json");
    const events = [];
    stash.on("dropped", (e) => events.push(e.id));
    stash.on("expired", (e) => events.push(e.id));
    assert.equal(await stash.drop(ref), true, "a corrupt entry is still droppable -- drop never parses the sidecar");
    assert.ok(!existsSync(mp(root, ref)) && !existsSync(bp(root, ref)), "sidecar and blob both gone");
    assert.deepEqual(events, [], "no lifecycle event -- there is no whole Entry to carry");
  });

  test("verify SPARES a blob claimed DURING the walk -- the missing-blob check re-reads claims/ LIVE, never a stale snapshot (CWE-362)", async () => {
    const root = freshRoot();
    // A probe backend that, on the target's per-entry stat (verify's own read),
    // moves its blob blobs/ -> claims/ exactly as a concurrent pop's claim would --
    // AFTER verify began its walk. The blob is then absent from blobs/ but live in
    // claims/; a stale top-of-walk snapshot would call it missing-blob and, under
    // repair, destroy the sidecar out from under the reader.
    class ClaimMidWalk extends DiskBackend {
      root; armId = null;
      async stat(id) {
        const e = await super.stat(id);
        if (id === this.armId) { this.armId = null; renameSync(join(this.root, "blobs", id), join(this.root, "claims", id)); }
        return e;
      }
    }
    const probe = new ClaimMidWalk({ root }); probe.root = root;
    const stash = new Stash({ backend: probe });
    const ref = await stash.push("live-and-being-read");
    probe.armId = ref; // the next stat(ref) is verify's per-entry read; it claims the blob mid-walk
    const rep = await stash.verify({ repair: true });
    assert.deepEqual(rep.findings.filter((f) => f.kind === "missing-blob"), [], "a claimed blob is NOT missing");
    assert.deepEqual(rep.repaired, [], "repair destroys nothing -- the entry is live, mid-read");
    assert.equal(existsSync(mp(root, ref)), true, "the sidecar survives -- never yanked out from under the reader");
    assert.equal(existsSync(join(root, "claims", ref)), true, "the blob is safe in claims/");
  });

  test("verify FAULTS (throws) when meta/ vanishes mid-walk -- a layout fault is never masked as corrupt-sidecar findings (CWE-392)", async () => {
    const root = freshRoot();
    // A probe that removes meta/ on the per-entry stat, so stat's #containedDir
    // raises the "store layout is damaged" IntegrityError -- the SAME error class a
    // corrupt sidecar raises. verify must re-resolve and re-throw the FAULT, not
    // record a spurious corrupt-sidecar finding for an undamaged entry.
    class VanishMeta extends DiskBackend {
      root; armed = false;
      async stat(id) {
        if (this.armed) { this.armed = false; rmSync(join(this.root, "meta"), { recursive: true, force: true }); }
        return super.stat(id);
      }
    }
    const probe = new VanishMeta({ root }); probe.root = root;
    const stash = new Stash({ backend: probe });
    await stash.push("entry");
    probe.armed = true; // the next stat -- verify's per-entry read -- removes meta/ then hits the layout fault
    await assert.rejects(stash.verify(), (e) => e instanceof IntegrityError);
  });

  test("a size-mismatched blob is size-mismatch, removed under repair", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("exact");
    appendFileSync(bp(root, ref), "extra");
    const dry = await stash.verify();
    assert.deepEqual(dry.findings, [{ kind: "size-mismatch", id: ref }]);
    await stash.verify({ repair: true });
    assert.equal(existsSync(bp(root, ref)), false);
  });

  test("a symlink where a blob should be is a finding, its target never opened", { skip: !FILE_SYMLINKS }, async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("real");
    const outside = freshRoot(); mkdirSync(outside, { recursive: true });
    const secret = join(outside, "secret"); writeFileSync(secret, "attacker");
    rmSync(bp(root, ref)); symlinkSync(secret, bp(root, ref), "file");
    const report = await stash.verify();
    assert.ok(report.findings.some((f) => f.id === ref), "the symlinked blob is a finding");
    assert.equal(readFileSync(secret, "utf8"), "attacker", "the link target was never opened or followed");
  });

  test("a stale claim is stale-claim, REPORTED but never repaired (recovery owns resolution)", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("claimed");
    plantClaim(root, ref); // stale claim, sidecar intact
    const dry = await stash.verify();
    assert.ok(dry.findings.some((f) => f.kind === "stale-claim" && f.id === ref));
    await stash.verify({ repair: true });
    assert.equal(existsSync(join(root, "claims", ref)), true, "the claimed bytes stay -- deleting a restorable claim would be data loss");
  });

  test("verify digest-checks a CLAIMED blob and reports its corruption, but NEVER condemns it (mid-pop; recovery owns it)", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("claimed bytes");
    plantClaim(root, ref, { ageMs: 0 }); // a LIVE claim (not stale): blob in claims/, sidecar intact
    const claimPath = join(root, "claims", ref);
    const buf = readFileSync(claimPath); buf[0] ^= 0xff; writeFileSync(claimPath, buf); // corrupt the claimed blob (same size)
    const dry = await stash.verify();
    assert.ok(dry.findings.some((f) => f.kind === "digest-mismatch" && f.id === ref), "the corrupt claimed blob IS digest-checked and reported");
    assert.ok(!dry.findings.some((f) => f.kind === "stale-claim"), "a fresh claim is not stale");
    const rep = await stash.verify({ repair: true });
    assert.deepEqual(rep.repaired, [], "a claimed entry is NEVER condemned -- the pop's drain-verify / recovery owns it");
    assert.equal(existsSync(claimPath), true, "the claimed blob is left in place");
    assert.equal(existsSync(mp(root, ref)), true, "the sidecar is left in place");
  });

  test("verify() on a fresh store's FIRST op does NOT run crash recovery: a stale claim is reported, never restored (a dry run stays read-only, SPEC.md 6)", async () => {
    const root = freshRoot();
    const setup = new Stash({ backend: new DiskBackend({ root }) });
    const ref = await setup.push("claimed");
    plantClaim(root, ref); // a prior run's abandoned pop: stale claim, sidecar intact
    // A NEW store whose first op is a dry-run verify must audit the store as-is.
    // Running #recover here would restore/burn the claim (a mutation) and hide the
    // very stale-claim finding verify exists to surface -- an auditor process after
    // a crash must see the residue, not silently clean it.
    const auditor = new Stash({ backend: new DiskBackend({ root }) });
    const dry = await auditor.verify();
    assert.ok(dry.findings.some((f) => f.kind === "stale-claim" && f.id === ref), "the stale claim is REPORTED, not resolved");
    assert.equal(existsSync(join(root, "claims", ref)), true, "the claim is untouched -- verify resolved nothing");
    assert.equal(existsSync(bp(root, ref)), false, "the blob stayed in claims/, never restored to blobs/");
  });

  test("an AGED .tmp in meta/ (a crashed sidecar write) is orphan-tmp, reaped under repair; a fresh one is spared", async () => {
    const { root, stash } = freshStash();
    await stash.push("keep");
    // #writeAtomic streams a sidecar to meta/<id>.json.tmp before the rename; a
    // crash strands it. The meta/ walk must age it like the blobs/ walk does, not
    // skip every .tmp forever and leave the store's temp litter unaudited.
    const stale = join(root, "meta", "crashed.json.tmp"); writeFileSync(stale, "half a sidecar");
    const old = new Date(Date.now() - TWO_HOURS); utimesSync(stale, old, old);
    const fresh = join(root, "meta", generate() + ".json.tmp"); writeFileSync(fresh, "in-flight write"); // mtime = now
    const dry = await stash.verify();
    assert.deepEqual(dry.findings, [{ kind: "orphan-tmp", id: null }], "only the aged meta .tmp is an orphan; the fresh one is an in-flight write");
    await stash.verify({ repair: true });
    assert.equal(existsSync(stale), false, "repair reaps the stranded meta sidecar .tmp");
    assert.equal(existsSync(fresh), true, "the in-flight sidecar write is spared (CWE-367)");
  });

  test("an AGED .tmp in claims/ is orphan-tmp too -- the temp sweep covers every layout dir", async () => {
    const { root, stash } = freshStash();
    await stash.push("keep");
    const stale = join(root, "claims", "crashed.tmp"); writeFileSync(stale, "junk");
    const old = new Date(Date.now() - TWO_HOURS); utimesSync(stale, old, old);
    const dry = await stash.verify();
    assert.ok(dry.findings.some((f) => f.kind === "orphan-tmp"), "a stale claims/ .tmp is an orphan too, not skipped");
    await stash.verify({ repair: true });
    assert.equal(existsSync(stale), false, "repair reaps it");
  });

  test("verify FAULTS on an I/O error, never resolves a clean report", { skip: CANNOT_FAULT }, async () => {
    const { root, stash } = freshStash();
    await stash.push("x");
    chmodSync(join(root, "meta"), 0o000); // deny the walk
    try {
      await assert.rejects(stash.verify(), (e) => e.code === "EACCES" || e.code === "EPERM");
    } finally {
      chmodSync(join(root, "meta"), 0o700); // restore so cleanup can remove the dir
    }
  });

  test("stats is loud on a FOREIGN file in the layout, matching list()", async () => {
    const { root, stash } = freshStash();
    await stash.push("ok");
    writeFileSync(join(root, "meta", "not-json-not-ref"), "x");
    await assert.rejects(stash.stats(), IntegrityError);
  });

  test("has over a corrupt sidecar throws IntegrityError, never answering false (CWE-703)", async () => {
    const { root, stash } = freshStash();
    const ref = await stash.push("v");
    writeFileSync(mp(root, ref), "{ corrupt");
    await assert.rejects(stash.has(ref), IntegrityError);
  });

  test("an expired-but-unswept entry is counted by stats until prune reaps it", async () => {
    const { stash } = freshStash();
    await stash.push("live");
    await stash.push("dead", { ttl: 0 }); // expired, unswept
    assert.equal((await stash.stats()).entries, 2, "the expired entry still counts physically");
    assert.equal(await stash.prune(), 1);
    assert.equal((await stash.stats()).entries, 1, "reaped -> no longer counted");
  });
});
