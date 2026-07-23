// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
/**
 * @module     stash.backends
 *
 * (Continuation block: the stash.backends page metadata lives with the
 * memory backend; this file's primitives render on the same page.)
 */

import { randomBytes } from "node:crypto";
import { constants as FS } from "node:fs";
import { link, lstat, lutimes, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { C } from "../constants.js";
import { DEFAULT_DIGEST, algoOf, digestHash, finalize } from "../digest.js";
import { assertShape, assertTombstoneShape, spend } from "../entry.js";
import { IntegrityError, InvalidRef, RefClaimed, RefNotFound } from "../errors.js";
import { assertValid, constantTimeEqual, isValid } from "../ref.js";
import { options } from "../validate.js";

// The disk layout's required directories, in one place: #init creates every one,
// and a consumer that must recognize a real stash root (the CLI's layout pre-check)
// validates against THIS set, so a new layout directory extends both at once.
// The dirs that must pre-exist for a path to be a valid disk stash root -- the CLI's
// layout check requires exactly these. blobs/meta/claims/tombstones have defined a stash
// since M2/M7; delivered/ (the SPEC.md 6 burn-delivery markers) is auto-created by #init on first
// use, so it is NOT required to pre-exist -- a pre-0.1.17 root without it is still a valid
// stash, and opening it (library or CLI) creates the dir.
export const CORE_SUBDIRS = ["blobs", "meta", "claims", "tombstones"];
export const SUBDIRS = [...CORE_SUBDIRS, "delivered"];

// A sidecar is one Entry's JSON: id + counters + caller meta. Far above
// any legitimate sidecar, far below a parser-DoS payload -- a sidecar
// larger than this is rejected unread.
const MAX_SIDECAR_BYTES = 64 * C.BYTES.KIB;

// A tombstone is { id, destroyedAt, cause } -- tens of bytes. 1 KiB is generous
// and refuses a parser-DoS payload unread (CWE-770/400), the sidecar-cap precedent.
const MAX_TOMBSTONE_BYTES = C.BYTES.KIB;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// remove()'s in-process exactly-once witness (#reaped) holds at most this many
// recently-removed ids. Far above any real concurrent-reap window (the racers of
// one entry are microseconds apart); the oldest is evicted past that window, where
// a re-remove of a long-gone id -- its Windows delete long finalized -- reads ENOENT.
const REAP_MEMO = 4096;

// A stored file is read through its own descriptor: open once, verify the
// descriptor, then read or stream from that same handle. The check and the
// use share one fd, so nothing re-resolves the path between them -- a blob
// or sidecar swapped for a symlink (or a different file) after a path check
// but before the read is the time-of-check/time-of-use class (CWE-367), and
// a path-based read follows the swap. O_NOFOLLOW refuses a symlink where a
// blob or sidecar belongs at open time on POSIX. O_RDONLY is 0.
//
// O_NONBLOCK guards the open itself: a blob or sidecar swapped for a FIFO
// (named pipe) with no writer parks an O_RDONLY open FOREVER on POSIX --
// before fstat can run to reject the non-regular shape -- so a read would
// hang instead of failing. Opening non-blocking returns immediately (or
// ENXIO for a device with no reader), and the fstat then rejects the
// non-regular file. It is inert for a regular file: POSIX read semantics
// ignore O_NONBLOCK on regular files, so streaming a real blob is
// unaffected. O_NONBLOCK is 0 on platforms that lack it (Windows), where a
// FIFO cannot be planted unprivileged in the first place.
const READ_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW || 0) | (FS.O_NONBLOCK || 0);
// The read discipline's flags with O_RDWR for an in-place sidecar rewrite, and
// deliberately NO O_CREAT: consumeRead must debit an EXISTING sidecar, never
// recreate one a concurrent drop removed (SPEC 4.2 monotone). The open ENOENTs
// if the entry is gone; it never brings a dropped entry back.
const WRITE_FLAGS = FS.O_RDWR | (FS.O_NOFOLLOW || 0) | (FS.O_NONBLOCK || 0);

// Windows lacks O_NOFOLLOW (0 above), so the open cannot refuse a symlink on
// its own there; a post-open lstat cross-checks the final component instead.
// The open already bound the descriptor, so that lstat can only REJECT a
// symlinked name -- it never redirects the read, which draws from the fd.
// File-symlink creation on Windows also needs a privilege the sandbox denies.
const SYMLINK_GUARD_NEEDED = (FS.O_NOFOLLOW || 0) === 0;

// absent(err) -> true for ENOENT, rethrows anything else. The one place
// "file not found" legitimately converts to a fact instead of a failure.
function _absent(err) {
  if (err && err.code === "ENOENT") return true;
  throw err;
}

// A rename/link/unlink is a first-try success on POSIX, but Windows -- which
// does not swap or drop an open file freely -- refuses it with EPERM/EACCES/
// EBUSY while a handle on the file lingers: a concurrent reader holding a
// sidecar or blob open during a claim storm, or the OS lazily releasing a
// just-closed handle (antivirus, indexer). The contention window is a few
// event-loop turns, so a bounded backoff clears it; POSIX lands on the first
// attempt, leaving the retry inert. Only these transient codes retry -- the
// callback's EEXIST (a name already present) and ENOENT (a name already gone)
// surface immediately for the caller to interpret.
const FS_RETRY_LIMIT = 50;
const FS_RETRY_DELAY_MS = 4;
const TRANSIENT_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
async function _retryTransient(fn) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!err || !TRANSIENT_FS_CODES.has(err.code) || attempt >= FS_RETRY_LIMIT) throw err;
      await new Promise((resolve) => setTimeout(resolve, FS_RETRY_DELAY_MS));
    }
  }
}

// Write the ENTIRE buffer, looping over short writes: a single write() can
// resolve after fewer than `length` bytes, and a truncated sidecar or blob reads
// back as corruption -- losing a completed drain's read budget, or failing a
// digest that was in fact correct. Bytes go to `position + written` so the loop
// is offset-correct for both a fresh file and an in-place rewrite. A write that
// makes no progress is a fault, not a retry.
export async function _writeAll(fh, bytes, position) {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await fh.write(bytes, written, bytes.length - written, position + written);
    if (bytesWritten === 0) throw new IntegrityError("store write made no progress");
    written += bytesWritten;
  }
}

// A symlink refused at open (ELOOP, POSIX O_NOFOLLOW), a non-file the open
// itself rejected (EISDIR on platforms that block opening a directory), or a
// device / FIFO whose non-blocking open has no peer (ENXIO) is store
// tampering, not absence: a blob or sidecar is a regular file, and any of
// these means something else was put where one belongs.
function _openTamper(err) {
  return err && (err.code === "ELOOP" || err.code === "EISDIR" || err.code === "ENXIO");
}

// descriptorMatchesName(opened, named) -- does an open descriptor still
// speak for the in-root name it was opened through? `opened` is the fstat
// of the descriptor (the object the read will actually draw from); `named`
// is a no-follow lstat of the path. They agree only for an untampered
// regular file: if the open traversed a symlink, `named` is the link and
// `opened` is its target; if the name was swapped after the open, `named`
// is the new object and `opened` is the original. Either way the dev+ino
// pair differs, and a symlinked name is rejected outright. This is the
// no-follow guard on a platform without O_NOFOLLOW, where the open cannot
// refuse a symlink itself -- exported so its contract is pinned directly.
export function descriptorMatchesName(opened, named) {
  return !named.isSymbolicLink() && sameFile(opened, named);
}

// sameFile(a, b) -- do two fs.Stats describe the SAME on-disk object? The disk
// backend's file-identity comparison, declared ONCE so no other path re-inlines a
// dev+ino check that drifts. dev+ino is the POSIX identity, but Windows synthesizes
// ino from the NTFS file index and can transiently report 0 for distinct files
// under heavy parallel I/O -- so two different in-root files can collide at
// {dev, ino:0}. size and birthtimeMs are ANDed on as tiebreaks: both are populated
// on the Windows fstat AND lstat path, and identical for one object (fstat and lstat
// of the same inode agree), so an untampered read never false-rejects; the terms
// only ever make the predicate MORE selective, so the swap defense cannot be
// weakened (hard rule 12), while two distinct files must now ALSO collide on size
// and creation time to be mistaken for one -- not attacker-controllable in the swap
// window over write-once immutable blobs.
// @enforced-by guard-shape-reinlined
// @guard-shape \.ino\s*===
export function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.birthtimeMs === b.birthtimeMs;
}

// verifyDescriptorAgainstName(openedStat, path, damaged) -> boolean. The fallback
// swap guard for platforms without O_NOFOLLOW (Windows), where the open cannot
// refuse a symlink itself. A no-follow lstat of the name is cross-checked against
// the open descriptor's fstat via descriptorMatchesName: a symlink traversed at
// open, or a name SWAPPED for a different object after it, is refused as corruption
// (IntegrityError). A name that VANISHED after the open (ENOENT) is a concurrent
// REMOVAL, not a swap -- it reports absence (false), which #openStored maps to the
// caller's onAbsent (a sidecar reads back RefNotFound, tolerated by list()/prune()
// mid-reap). Either verdict is served the SAME way: #openStored closes the handle
// unread, so no traversed descriptor is ever returned -- the swap defense is intact,
// only a legitimate concurrent removal stops being misreported as corruption. Any
// other lstat fault propagates. Lifted out of the read path -- as
// descriptorMatchesName was -- so its branches are pinned on every platform.
export async function verifyDescriptorAgainstName(openedStat, path, damaged) {
  let named;
  try {
    named = await lstat(path);
  } catch (err) {
    if (_absent(err)) return false; // vanished after open -- absence (a concurrent removal), never a served handle
    throw err; // any other lstat fault propagates
  }
  if (!descriptorMatchesName(openedStat, named)) {
    throw new IntegrityError(damaged);
  }
  return true; // the name still vouches for the descriptor
}

/**
 * @primitive  stash.backends.DiskBackend
 * @signature  new DiskBackend(opts) -> DiskBackend
 * @since      0.1.1
 * @status     experimental
 * @spec       SPEC.md 9, SPEC.md 2.1, RFC 8259
 * @defends    CWE-22, CWE-59, CWE-367, CWE-377, CWE-770, path traversal (CWE-23)
 * @related    stash.backends.MemoryBackend, stash.Stash
 *
 * Construct the sidecar-file disk backend over `opts.root`. The layout is
 * `blobs/<id>` + `meta/<id>.json` (plus the claim and tombstone
 * directories their milestones will use), directories mode 0700 and files
 * 0600, with no central index to corrupt: a listing is a readdir plus
 * sidecar reads. Writes stream to a `.tmp`, fsync, then rename -- a
 * reader never sees a partial blob, and a crash leaves an invisible
 * orphan rather than a half-entry. The constructor does no I/O; the
 * layout appears on first use.
 *
 * Containment is the backend's own job, not the sandbox's: the root is
 * realpath-pinned at init, every operation re-asserts that its directory
 * still resolves inside it, and a symlink where a blob should be is
 * refused as corruption rather than followed. Blob and sidecar reads open
 * a descriptor and verify it there -- fstat gates the shape, the read
 * draws from the same handle -- so the path is never re-resolved between
 * the check and the read, and a file swapped in behind the check cannot
 * redirect it.
 *
 * @example
 *   import { Stash } from "@blamejs/stash";
 *   import { DiskBackend } from "@blamejs/stash/backends/disk";
 *
 *   const stash = new Stash({ backend: new DiskBackend({ root: "./.stash" }) });
 */
export class DiskBackend {
  #root;
  #realRoot = null;
  #initPromise = null;
  #reaped = new Set(); // ids this instance has removed -- the exactly-once witness the fs cannot give on Windows

  constructor(opts) {
    options(opts, "new DiskBackend", { allowed: ["root"] });
    if (typeof opts.root !== "string" || opts.root.length === 0) {
      throw new TypeError("new DiskBackend: root must be a non-empty path string");
    }
    this.#root = resolve(opts.root);
  }

  // The store's process-wide identity: its CANONICAL root path, so the policy layer's
  // single-writer-per-root guard (SPEC.md 6) coordinates two Stash over the SAME store --
  // even via distinct DiskBackend instances, and even through different path spellings (a
  // symlink to the root, a case variant on a case-insensitive fs) -- as one writer, so
  // neither's recovery age-reclaims the other's live read. #init realpaths the root ONCE
  // and caches it (#realRoot), so this getter is STABLE and does NO I/O: the policy layer
  // binds the guard LAZILY, after the first operation has run #init, so it always reads the
  // canonical value. The resolved path is only a placeholder for a read before init (which
  // the lazy binding avoids). This is a coordination KEY only -- never the containment
  // realpath (#containedDir); no operation trusts a path from here.
  get identity() { return "disk:" + (this.#realRoot ?? this.#root); }

  // Lazy, memoized layout creation (constructors do no I/O). A failed
  // init clears the memo so the next operation retries instead of
  // poisoning the instance forever.
  #init() {
    if (this.#initPromise === null) {
      this.#initPromise = (async () => {
        await mkdir(this.#root, { recursive: true, mode: DIR_MODE });
        for (const sub of SUBDIRS) {
          await mkdir(join(this.#root, sub), { recursive: true, mode: DIR_MODE });
        }
        this.#realRoot = await realpath(this.#root);
      })().catch((err) => {
        this.#initPromise = null;
        throw err;
      });
    }
    return this.#initPromise;
  }

  // The containment choke point: resolve a subdirectory and assert its
  // realpath is still the directory pinned under the real root. A
  // subdirectory that resolves elsewhere (a planted link) is an escape ->
  // InvalidRef; a subdirectory that vanished is store tampering ->
  // IntegrityError. The permission-model sandbox follows symlinks out of
  // granted paths, so this check is the actual wall (SPEC.md 2.1, 9).
  //
  // Verified limitation: a path check cannot defend against a same-privilege
  // attacker who swaps the directory in the microseconds between this
  // realpath and the open/rename that consumes its result. It refuses links
  // that persist across the check; the 0700 operator-owned root (SPEC.md 2.1)
  // is the boundary against a same-privilege swap. Callers therefore resolve
  // this immediately before the write into the directory -- never once at the
  // top of an operation that then streams for an unbounded time -- so the
  // window is the tightest the runtime allows.
  // @enforced-by guard-shape-reinlined
  // @guard-shape \brealpath(?:Sync)?\s*\(
  async #containedDir(subdir) {
    await this.#init();
    const expected = join(this.#realRoot, subdir);
    let real;
    try {
      real = await realpath(expected);
    } catch (err) {
      if (err && err.code === "ENOENT") throw new IntegrityError("store layout is damaged");
      throw err;
    }
    if (real !== expected) throw new InvalidRef();
    return expected;
  }

  // #openStored(path, onAbsent, damaged) -> FileHandle. The read discipline
  // in one place: open the file (O_NOFOLLOW refuses a symlink at open on
  // POSIX), fstat the descriptor to confirm a regular file, and -- only
  // where the platform lacks O_NOFOLLOW -- cross-check the descriptor's
  // identity against the name. The open already bound the descriptor, so the
  // check can only ever REJECT; it never redirects the read, which draws
  // from the returned handle. ENOENT is the caller's chosen absence
  // (`onAbsent()`); a non-regular, symlinked, or swapped name is `damaged`.
  // The caller owns closing the handle.
  //
  // On a platform without O_NOFOLLOW the open follows a symlink, so a
  // path-name lstat AFTER the open is a check-then-use of its own: an
  // attacker who swaps the symlink for a regular in-root file between the
  // open and the lstat passes the check while the descriptor stays bound to
  // the outside target. The identity of the OPENED OBJECT is the only thing
  // the swap cannot change -- fstat reports the descriptor's dev+ino, and a
  // no-follow lstat of the name reports what the name points at NOW. If the
  // open traversed a symlink they name different objects; if the name was
  // swapped after the open they name different objects; only an untampered
  // regular file makes fstat and lstat agree. Comparing them binds the
  // verdict to the descriptor, closing the window O_NOFOLLOW closes on POSIX.
  async #openStored(path, onAbsent, damaged, flags = READ_FLAGS) {
    let fh;
    try {
      fh = await open(path, flags);
    } catch (err) {
      if (err && err.code === "ENOENT") throw onAbsent();
      if (_openTamper(err)) throw new IntegrityError(damaged);
      throw err;
    }
    try {
      const opened = await fh.stat();
      if (!opened.isFile()) throw new IntegrityError(damaged);
      if (SYMLINK_GUARD_NEEDED && !(await verifyDescriptorAgainstName(opened, path, damaged))) {
        throw onAbsent(); // the name vanished after open (a concurrent removal) -- absence, never a served descriptor
      }
    } catch (err) {
      await fh.close();
      throw err;
    }
    return fh;
  }

  // Write bytes to <name>.tmp, fsync, rename into place. ANY failure after
  // the handle opens -- a write/sync fault or a rename that cannot land
  // (an obstacle at the destination, a directory swapped away) -- removes
  // the tmp before rethrowing: a rejected write leaves no partial behind.
  async #writeAtomic(dir, name, bytes) {
    const tmpPath = join(dir, name + ".tmp");
    const finalPath = join(dir, name);
    const fh = await open(tmpPath, "wx", FILE_MODE);
    try {
      try {
        await _writeAll(fh, bytes, 0);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await _retryTransient(() => rename(tmpPath, finalPath));
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }
    return finalPath;
  }

  // write(id, source, entry) -> Entry. Streams chunks to blobs/<id>.tmp
  // computing size and digest as they pass, fsyncs, renames into place,
  // THEN writes the sidecar -- so a crash at any point leaves either
  // nothing or an invisible blob orphan, never a served half-entry. Any
  // REJECTION (a source error, a sync fault, a rename that cannot land)
  // removes the tmp partial: a failed push leaves nothing behind.
  //
  // A directory's containment is re-asserted immediately before the write
  // that lands in it, never once at the top: the blob stream runs for as
  // long as its source chooses, and a containment check taken before the
  // stream would vouch for the meta directory across that whole window. An
  // attacker who swaps meta for a link out of the root mid-stream would then
  // land the sidecar outside the root, because the check passed on the
  // pre-swap directory and the write followed the post-swap one -- the
  // time-of-check/time-of-use class (CWE-367) on the directory path.
  // Resolving #containedDir("meta") right before the sidecar write narrows
  // that window to the microseconds between the realpath and the open.
  async write(id, source, entry) {
    assertValid(id);
    // The algorithm rides IN the entry's self-describing digest (a fresh push's
    // pending "<algo>:" marker, a replicated entry's full "<algo>:<hex>"), so the
    // policy layer's selection reaches the backend through the documented argument,
    // never an out-of-band one; a markerless entry defaults to sha256, unchanged.
    const algo = algoOf(entry.digest) ?? DEFAULT_DIGEST;
    const blobDir = await this.#containedDir("blobs");
    const tmpPath = join(blobDir, id + ".tmp");
    const blobPath = join(blobDir, id);
    const hash = digestHash(algo);
    let size = 0;
    const fh = await open(tmpPath, "wx", FILE_MODE);
    try {
      try {
        for await (const chunk of source) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          hash.update(buf);
          await _writeAll(fh, buf, size); // write at the running offset, looping short writes
          size += buf.length;
        }
        await fh.sync();
      } finally {
        await fh.close();
      }
      // The just-closed tmp's handle can linger on Windows (antivirus, indexer,
      // or the OS lazily releasing it), failing this rename with a transient
      // EPERM/EACCES/EBUSY while a legitimate push races that window.
      // _retryTransient absorbs it exactly as the sidecar (#writeAtomic) and the
      // claim-lifecycle renames do; POSIX lands on the first attempt, inert.
      await _retryTransient(() => rename(tmpPath, blobPath));
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }

    const stored = structuredClone(entry);
    stored.size = size;
    stored.digest = finalize(hash, algo);
    const sidecar = Buffer.from(JSON.stringify(stored), "utf8");
    if (sidecar.length > MAX_SIDECAR_BYTES) {
      await rm(blobPath, { force: true });
      throw new TypeError("push: meta too large for a sidecar");
    }
    try {
      const metaDir = await this.#containedDir("meta");
      await this.#writeAtomic(metaDir, id + ".json", sidecar);
    } catch (err) {
      await rm(blobPath, { force: true });
      throw err;
    }
    return structuredClone(stored);
  }

  // read(id) -> Readable over the blob. The entry must exist (sidecar
  // present and valid); a sidecar without its blob is corruption. The blob
  // is opened once and streamed from that descriptor, so no path is
  // re-resolved after the check -- a symlink swapped in for the blob cannot
  // redirect the read.
  async read(id) {
    const entry = await this.stat(id);
    const blobDir = await this.#containedDir("blobs");
    const blobPath = join(blobDir, entry.id);
    const damaged = "blob storage shape is damaged";
    // A blob missing from blobs/ under a present sidecar is NOT absence: it is a
    // live claim (the blob moved to claims/ for a pop) or corruption. onAbsent
    // hands back a RefNotFound sentinel the catch resolves to RefClaimed or
    // IntegrityError -- never a plain RefNotFound to the caller, because the
    // entry is not gone, it is being served or damaged.
    let fh;
    try {
      fh = await this.#openStored(blobPath, () => new RefNotFound(), damaged);
    } catch (err) {
      if (err instanceof RefNotFound) throw await this.#claimAwareAbsent(entry.id, damaged);
      throw err;
    }
    return fh.createReadStream();
  }

  // #claimAwareAbsent(id, damaged) -- verdict for a blob missing from blobs/
  // under a present sidecar (fragile area 2). A no-follow lstat of claims/<id>:
  // present means the blob was moved there for a pop -> RefClaimed (the entry is
  // being served, not gone); absent means the sidecar has no blob anywhere ->
  // IntegrityError. Reporting RefClaimed keeps a concurrent reader from being
  // told a popped entry is "corrupt" -- the boy-who-cried-wolf failure that
  // trains operators to ignore EINTEGRITY.
  async #claimAwareAbsent(id, damaged) {
    const claimsDir = await this.#containedDir("claims");
    try {
      await lstat(join(claimsDir, id));
      return new RefClaimed();
    } catch (err) {
      _absent(err);
      return new IntegrityError(damaged);
    }
  }

  // remove(id) -> boolean. Sidecar first (the entry stops existing), then the
  // blob. Absent is a fact, not a failure. The boolean is the single-writer WITNESS
  // the 'expired'/'dropped' exactly-once emit depends on: true for EXACTLY ONE of
  // two removes racing the same entry (a lazy read vs the sweeper). The FILESYSTEM
  // cannot supply that witness on Windows -- an unlink (or rename) of a sidecar a
  // concurrent reader holds open (libuv opens FILE_SHARE_DELETE) marks it for
  // deletion but the NAME LINGERS until that handle closes, so a second remove --
  // even one running AFTER the first returned -- still sees the name and also
  // reports success. So the witness is kept in-process: `#reaped` records the ids
  // this instance has removed, CLAIMED synchronously before the first await (atomic
  // against a concurrent remove), so exactly one caller ever witnesses true. Scoped
  // to the instance -- SPEC.md 4.3's exactly-once is per Stash (its own lazy-read
  // gate vs its own sweeper), never cross-process. Refs are never reused, so a
  // claimed id never legitimately returns; the record is a bounded FIFO (evicting
  // the oldest far past any concurrent-reap window) so it cannot grow without bound.
  async remove(id) {
    assertValid(id);
    if (this.#reaped.has(id)) return false; // this instance already removed it (the fs name may still linger)
    this.#reaped.add(id); // claim BEFORE any await: atomic vs a concurrent remove of the same id
    if (this.#reaped.size > REAP_MEMO) this.#reaped.delete(this.#reaped.values().next().value); // evict oldest
    // ANY failure after the claim un-claims the marker, so a retry (once the fault
    // clears) re-attempts rather than being told "already removed" and skipping a
    // still-present entry -- the claim is only authoritative once the removal lands.
    try {
      // Each directory is contained immediately before its own op, not both up
      // front: a resolve-early/use-late gap is the same directory time-of-check/
      // time-of-use window write() closes (CWE-367).
      const metaDir = await this.#containedDir("meta");
      let had = true;
      try {
        // rm (recursive, NO force) removes the sidecar whether it is the normal
        // regular file OR a tampered directory where the sidecar belongs (which
        // verify repair must still reap) -- without force so an ENOENT is the
        // "already gone" witness. rm removes a final-component symlink ITSELF, never
        // following it, so a swap cannot redirect the deletion to another file
        // (CWE-59/367); the exactly-once witness is #reaped (in-process), not this
        // op's atomicity. _retryTransient absorbs a Windows EPERM against a lingering
        // handle.
        await _retryTransient(() => rm(join(metaDir, id + ".json"), { recursive: true }));
      } catch (err) {
        if (_absent(err)) had = false; // already gone (an external / cross-process removal) -- not us
        else throw err;
      }
      const blobDir = await this.#containedDir("blobs");
      // force AND recursive: the blob is normally a regular file (recursive is inert
      // on one), but verify repair must also reap a tampered directory-shaped blob.
      // rm removes a final-component symlink itself, never following it (CWE-59/367).
      await rm(join(blobDir, id), { force: true, recursive: true });
      return had;
    } catch (err) {
      this.#reaped.delete(id); // a real fault anywhere above: roll the claim back for a retry
      throw err;
    }
  }

  // stat(id) -> Entry, strictly validated: bounded read, JSON.parse under
  // a corruption verdict, exact shape via the canonical entry module, and
  // the sidecar's own id must be the id addressed. The sidecar is opened
  // once and every check runs on that descriptor -- fstat gates the shape
  // and the size bound, and the read draws from the same fd -- so no path is
  // re-resolved after the check (a symlink swapped in for the sidecar cannot
  // redirect the read to attacker-chosen metadata).
  async stat(id) {
    assertValid(id);
    const metaDir = await this.#containedDir("meta");
    const sidecarPath = join(metaDir, id + ".json");
    const fh = await this.#openStored(sidecarPath, () => new RefNotFound(), "sidecar storage shape is damaged");
    try {
      return await this.#readSidecar(fh, id);
    } finally {
      await fh.close();
    }
  }

  // #readSidecar(fh, id) -> Entry. Read and strictly validate a sidecar from an
  // OPEN descriptor: bounded read, JSON.parse under a corruption verdict, exact
  // shape via the canonical entry module, and the sidecar's own id must be the id
  // addressed (constant-time, the same path refs and digests take). Shared by
  // stat (read-only) and consumeRead (which rewrites in place through the same
  // descriptor), so reader validation and the debit path can never diverge.
  async #readSidecar(fh, id) {
    if ((await fh.stat()).size > MAX_SIDECAR_BYTES) {
      throw new IntegrityError("sidecar exceeds its size bound");
    }
    const raw = await fh.readFile("utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new IntegrityError("sidecar is not valid JSON");
    }
    assertShape(parsed, IntegrityError);
    if (!constantTimeEqual(parsed.id, id)) throw new IntegrityError("sidecar identity mismatch");
    return parsed;
  }

  // #scanEntries(collectCorrupt) -> { entries, corrupt }. The single meta/ walk
  // behind both list() and listReconcilable(): readdir, then a per-name stat.
  // In-flight .tmp files are invisible by design. The scan is readdir-then-stat, so
  // an entry can be removed (a concurrent drop, or the sweeper reaping an expired
  // one) between the two steps: a sidecar seen by readdir is gone by the stat. That
  // entry has simply left the listing, so a RefNotFound for it is skipped in BOTH
  // faces. The ONE difference is a CORRUPT sidecar (an IntegrityError from stat):
  // list() (collectCorrupt false) is loud -- it rethrows, because silently dropping
  // a damaged sidecar from a listing would hide corruption; the reconciliation face
  // (collectCorrupt true) COLLECTS the id into `corrupt` and keeps walking, so one
  // rotten sidecar cannot halt replication of the healthy entries -- the damage is
  // SURFACED, never swallowed. Structural layout damage (a foreign name,
  // an invalid ref name) and every fs FAULT stay loud in BOTH faces: neither is a
  // per-entry corruption with a ref to report.
  async #scanEntries(collectCorrupt) {
    const metaDir = await this.#containedDir("meta");
    const entries = [];
    const corrupt = [];
    for (const name of await readdir(metaDir)) {
      if (name.endsWith(".tmp")) continue;
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : null;
      if (id === null || !isValid(id)) throw new IntegrityError("store layout is damaged");
      let entry;
      try {
        entry = await this.stat(id);
      } catch (err) {
        if (err instanceof RefNotFound) continue; // removed between readdir and stat -- no longer listed
        if (collectCorrupt && err instanceof IntegrityError) {
          // A per-entry corrupt sidecar is collected and the walk continues -- but a
          // STRUCTURAL layout fault (stat's own containment check throwing IntegrityError,
          // e.g. the meta directory swapped for a symlink out of the root mid-scan) must
          // stay loud even in this face. Re-resolve the layout: if it is now damaged, this
          // was not a per-entry corruption -- rethrow; if it is intact, the fault was this
          // one sidecar -- collect it. verify() reads this same {entries, corrupt}, so a
          // vanished or swapped layout dir surfaces there too, never masked as corruption.
          await this.#containedDir("meta"); // throws (loud) if the layout is damaged
          corrupt.push(id);
          continue;
        }
        throw err; // list()'s loud-not-lossy contract, and every fs fault, in both faces
      }
      entries.push(entry);
    }
    return { entries, corrupt };
  }

  // list() -> Entry[]. Loud, not lossy: a sidecar that fails validation fails the
  // listing -- silently skipping corruption would hide it. A RefNotFound for a
  // sidecar removed between the readdir and its stat is skipped (it has left the
  // listing); corruption and every other fault fail loudly. #scanEntries owns the
  // walk; list() is its loud face.
  async list() {
    return (await this.#scanEntries(false)).entries;
  }

  // listReconcilable() -> { entries, corrupt }. The reconciliation-grade listing
  // (SPEC.md 4.4): the healthy entries a full-scan anti-entropy pass can replicate,
  // plus the ref ids whose sidecars are too damaged to read. Where list() is loud
  // over a corrupt sidecar -- one damaged entry would abort the whole readdir walk
  // and stall replication of every healthy entry -- this face reports the corrupt
  // id in `corrupt` and keeps enumerating, so a single rotten sidecar
  // never blocks the sync of sound entries. Corruption is SURFACED, never silently
  // skipped: the caller replicates `entries` and routes `corrupt` to
  // verify({ repair: true }). Structural layout damage and fs faults stay loud, as
  // in list(). #scanEntries owns the walk; this is its resilient face.
  async listReconcilable() {
    return this.#scanEntries(true);
  }

  // stats() -> { entries, bytes, claimed }. The stash-wide limit pre-check reads
  // this aggregate rather than parsing every sidecar: `entries` is the sidecar
  // count (`.tmp` excluded), `bytes` the stored footprint -- each entry's blob
  // size PLUS its sidecar file size, PLUS any sidecar-less claim or orphan blob
  // still occupying the shelf, so a limit sees the real cost and a caller can't
  // slip past `maxTotal` with tiny blobs and huge `meta`, nor by hoarding crashed
  // removes' orphans. `claimed` is the count in claims/ (0 until the claim machinery
  // lands, M5). Loud, not lossy: a foreign name in ANY layout dir fails the same way
  // list() does. The sidecar is stat'd
  // BEFORE the entry is counted, so a sidecar that vanished between the readdir
  // and its lstat (a concurrent sweep or drop) is skipped entirely -- not counted
  // as an entry with zero bytes -- keeping `entries` in step with what list()
  // would report. Once the sidecar is counted, a blob that vanished the same way
  // contributes nothing rather than failing.
  async stats() {
    const metaDir = await this.#containedDir("meta");
    const blobDir = await this.#containedDir("blobs");
    const claimsDir = await this.#containedDir("claims");
    let entries = 0;
    let bytes = 0;
    const counted = new Set();
    for (const name of await readdir(metaDir)) {
      if (name.endsWith(".tmp")) continue;
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : null;
      if (id === null || !isValid(id)) throw new IntegrityError("store layout is damaged");
      let sidecarSize;
      try {
        sidecarSize = (await lstat(join(metaDir, name))).size; // the sidecar file
      } catch (err) {
        _absent(err); // the sidecar vanished mid-scan -> not a live entry; skip it
        continue;     // whole, the same tolerance list() holds -- never count it
      }
      entries += 1;
      bytes += sidecarSize;
      counted.add(id); // this id's blob (in blobs/ or claims/) is accounted here
      try {
        bytes += (await lstat(join(blobDir, id))).size; // the blob
      } catch (err) {
        _absent(err); // absent from blobs/ -> either vanished, or claimed (moved
        try {
          bytes += (await lstat(join(claimsDir, id))).size; // to claims/ -- a
        } catch (e2) {
          _absent(e2); // claimed blob still occupies the store, so count it there
        }
      }
    }
    let claimed = 0;
    for (const name of await readdir(claimsDir)) {
      if (name.endsWith(".tmp")) continue;
      if (!isValid(name)) throw new IntegrityError("store layout is damaged");
      claimed += 1;
      // A claim whose sidecar is gone (a drop during the claim) has no meta/ entry
      // to count it, but its blob still occupies the store -- count those bytes
      // against the footprint, or repeating pop+drop+abandon would hoard claim
      // blobs that every bounded push sees as an empty store (a maxTotal bypass).
      if (counted.has(name)) continue;
      counted.add(name); // account this claim's blob so the blobs/ walk cannot double-count a duplicate-link
      try {
        bytes += (await lstat(join(claimsDir, name))).size;
      } catch (err) {
        _absent(err); // vanished mid-scan (a concurrent restore/commit) -- skip
      }
    }
    // blobs/: an ORPHAN blob -- a valid ref name with no sidecar and no claim (a
    // crashed remove deletes the sidecar first, leaving the blob) -- still occupies
    // the store. Count it, or repeated crashed removes hoard orphans every bounded
    // push sees as free space: the same maxTotal bypass the sidecar-less claim above
    // closes. A foreign name is loud (like meta/ and claims/); a .tmp is an
    // in-flight push's partial, skipped.
    for (const name of await readdir(blobDir)) {
      if (name.endsWith(".tmp")) continue;
      if (!isValid(name)) throw new IntegrityError("store layout is damaged");
      if (counted.has(name)) continue; // already counted via its sidecar or its claim
      try {
        bytes += (await lstat(join(blobDir, name))).size;
      } catch (err) {
        _absent(err); // vanished mid-scan (a concurrent verify/drop) -- skip
      }
    }
    // tombstones/: M7's records; M6 writes none, so there are no bytes to count yet,
    // but the aggregate stays loud on a foreign name here as in every layout dir.
    for (const name of await readdir(await this.#containedDir("tombstones"))) {
      if (name.endsWith(".tmp")) continue;
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : null;
      if (id === null || !isValid(id)) throw new IntegrityError("store layout is damaged");
      // a grave (<id>.json) is tiny and not yet part of the footprint count (SPEC.md
      // 4 fixes Stats at { entries, bytes, claimed }); counting graves is a future
      // amendment. This walk stays loud on a FOREIGN name here, like every layout dir.
    }
    return { entries, bytes, claimed };
  }

  // #hashBlob(path, algo) -> { size, digest }. Stream-hash a stored blob with the
  // ENTRY's own algorithm (self-describing, so bit rot on a sha3-512 entry is caught
  // by re-hashing with sha3-512), through the contained, symlink-refused open (never
  // a full-blob read, SPEC.md 2): a symlink where the blob belongs is refused at
  // #openStored (O_NOFOLLOW / fstat guard), so verify follows nothing (CWE-59). Reads
  // in bounded chunks off the descriptor.
  async #hashBlob(path, algo) {
    const fh = await this.#openStored(path, () => new RefNotFound(), "blob storage shape is damaged");
    try {
      const hash = digestHash(algo);
      let size = 0;
      const buf = Buffer.allocUnsafe(64 * C.BYTES.KIB);
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        hash.update(buf.subarray(0, bytesRead));
        size += bytesRead;
      }
      return { size, digest: finalize(hash, algo) };
    } finally {
      await fh.close();
    }
  }

  // #condemn(id, kind, repaired) -- destroy a damaged entry: remove() deletes the
  // sidecar BEFORE the blob (the M2 order -- a crash between them leaves an
  // invisible blob orphan the next verify reaps, never a served half-entry).
  async #condemn(id, kind, repaired) {
    await this.remove(id);
    repaired.push({ kind, id });
  }

  // #condemnIfUnclaimed(id, kind, repaired) -- destroy a damaged entry ONLY if it
  // is not claimed RIGHT NOW. Claim state is re-checked LIVE at the condemnation,
  // never trusted from a snapshot taken earlier in the walk: the digest is verified
  // by an UNBOUNDED hash, and a pop can claim the blob DURING that hash, so a flag
  // read before it is already stale. A blob that became claimed while verify read
  // it is a live mid-pop entry -- its damage is reported (the finding was already
  // pushed) but it is NEVER condemned; the pop's drain-verify / recovery owns
  // resolving it (CWE-362/367). The residual check->remove window is the same
  // microsecond TOCTOU every store fs op holds (SPEC.md 2.1), not the whole hash.
  async #condemnIfUnclaimed(id, kind, repaired) {
    if (await this.#isPresent(join(await this.#containedDir("claims"), id))) return; // claimed now -- leave it for recovery
    await this.#condemn(id, kind, repaired);
  }

  // #discard(subdir, name, kind, repaired) -- remove a NON-entry file (a foreign
  // name, a stale .tmp) directly, re-resolving its parent (#containedDir)
  // immediately before the removal so a directory swap during the walk cannot
  // redirect the delete outside the root -- the same resolve-before-use window
  // remove()/write() hold, never a directory string resolved once at the top of an
  // unbounded walk (CWE-367). force AND recursive: the foreign/tmp shape may itself
  // be a tampered DIRECTORY, which repair must still reap; rm removes a
  // final-component symlink itself, never following it (CWE-59). Entries route
  // through #condemn/remove, never here.
  async #discard(subdir, name, kind, repaired) {
    await rm(join(await this.#containedDir(subdir), name), { force: true, recursive: true });
    repaired.push({ kind, id: null });
  }

  // #isPresent(path) -> boolean. lstat probe: present -> true; ENOENT -> false; any
  // OTHER errno is an fs FAULT and propagates. Re-checks a claim or a sidecar LIVE
  // at a condemnation decision rather than trusting a stale top-of-walk snapshot,
  // the way stats() re-checks claims/ before it counts (CWE-362).
  async #isPresent(path) {
    try {
      await lstat(path);
      return true;
    } catch (err) {
      _absent(err); // ENOENT -> genuinely absent; any other errno throws
      return false;
    }
  }

  // #auditOrphanTmp(subdir, dir, name, now, opts, findings, repaired) -> boolean.
  // The ONE `.tmp` verdict for every layout dir. A `.tmp` is an atomic write in
  // progress (write() / #writeAtomic stream to <name>.tmp, fsync, rename): a FRESH
  // one is that in-flight write and is spared (deleting it would corrupt a live
  // push -- CWE-367); one AGED past the grace is a crashed write's orphan --
  // reported as orphan-tmp and, under repair, discarded (parent re-resolved). Every
  // walk (meta/, blobs/, claims/) routes its `.tmp` handling here so none can strand
  // a stale temp the others reap (the meta/ and claims/ walks once skipped `.tmp`
  // unconditionally). Returns true when `name` was a `.tmp` -- the caller skips it.
  async #auditOrphanTmp(subdir, dir, name, now, opts, findings, repaired) {
    if (!name.endsWith(".tmp")) return false;
    let tmpStat = null;
    try {
      tmpStat = await lstat(join(dir, name));
    } catch (err) {
      _absent(err); // vanished mid-walk (the rename landed): a fault re-raises, ENOENT leaves tmpStat null
    }
    // A null tmpStat means the .tmp raced out from under us -- still a .tmp the
    // caller skips, just nothing left to age. A present one aged past the grace is
    // a crashed write's orphan; a fresh one is an in-flight write, spared (CWE-367).
    if (tmpStat !== null && now - tmpStat.mtimeMs >= C.AUDIT.TMP_GRACE_MS) {
      findings.push({ kind: "orphan-tmp", id: null });
      if (opts.repair) await this.#discard(subdir, name, "orphan-tmp", repaired);
    }
    return true; // it WAS a .tmp -- the caller skips it either way (never an entry)
  }

  // verify(opts) -> { scanned, findings, repaired }. Audit the physical layout,
  // composing the read choke points: #containedDir per subdir (re-resolved before
  // every readdir and unlink), this.stat for per-sidecar validation, #hashBlob for
  // the symlink-refused digest walk. Damage is a FINDING (returned); an fs FAULT
  // (EACCES, a vanished layout dir) THROWS -- a walk error absorbed into a clean
  // report is the fail-open-verify shape (CWE-392). Dry by default; repair removes
  // ONLY what it condemns (blob AND sidecar together), never a stale claim
  // (SPEC.md 6 recovery's job). It never deletes bytes a live operation still owns
  // (CWE-367): a claim taken mid-walk is re-checked LIVE before a missing-blob
  // verdict, and an orphan blob is condemned only once AGED past the grace with no
  // live sidecar or claim -- a fresh blob may be a push's post-rename/pre-sidecar
  // window, spared like an in-flight .tmp. ids in the report are refs (the embedder
  // owns the store); a foreign/tmp name reports id: null -- verify never echoes an
  // on-disk filename (SPEC.md 10).
  async verify(opts) {
    const now = Date.now();
    const findings = [];
    const repaired = [];
    const scanned = new Set(); // ref ids with a ref-shaped sidecar (an entry)

    // Each directory is re-resolved (#containedDir) immediately before the readdir
    // that enumerates it, before every per-entry blob read, and before every
    // destructive unlink -- never once at the top: the hash walk runs for an
    // unbounded time, so a same-privilege directory swap mid-walk is caught at the
    // next resolve, the tight window remove() and write() hold, not a directory
    // string vouched for once and reused across the whole walk (CWE-367).
    const metaDir = await this.#containedDir("meta");

    // meta/: each sidecar is an entry -- validate it, then check its blob.
    for (const name of await readdir(metaDir)) {
      if (await this.#auditOrphanTmp("meta", metaDir, name, now, opts, findings, repaired)) continue; // an in-flight or orphaned sidecar write
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : null;
      if (id === null || !isValid(id)) {
        findings.push({ kind: "foreign-file", id: null });
        if (opts.repair) await this.#discard("meta", name, "foreign-file", repaired);
        continue;
      }
      scanned.add(id);
      const blobDir = await this.#containedDir("blobs"); // re-resolved per entry, right before this entry's blob reads
      let entry;
      try {
        entry = await this.stat(id); // bounded read + assertShape + id match, free
      } catch (err) {
        if (err instanceof RefNotFound) continue; // vanished mid-walk (a concurrent drop)
        if (err instanceof IntegrityError) {
          // stat composes #containedDir (a vanished meta/ throws "store layout is
          // damaged" -- an fs FAULT) AND #readSidecar (a bad sidecar throws --
          // DAMAGE). Both are IntegrityError, so re-resolve the layout to
          // disambiguate: a still-present meta/ means the damage is this sidecar's
          // (a finding); a vanished meta/ RE-THROWS the fault rather than masking a
          // walk that fell over as N spurious corrupt-sidecar findings (CWE-392).
          await this.#containedDir("meta");
          findings.push({ kind: "corrupt-sidecar", id });
          // A corrupt sidecar may belong to a CLAIMED entry (a crash mid consumeRead
          // rewrite leaves the sidecar unparsable while the blob is live in claims/):
          // report the damage, but condemn only if it is not claimed right now.
          if (opts.repair) await this.#condemnIfUnclaimed(id, "corrupt-sidecar", repaired);
          continue;
        }
        throw err; // an fs FAULT -- never a finding
      }
      // Find the blob: normally blobs/<id>, but a pop/apply may have claimed it into
      // claims/<id> after this walk began -- re-check claims/ LIVE, never a stale
      // snapshot. A claimed blob is a live entry mid-read: it is STILL digest-checked
      // (a read audits every blob's integrity without mutating), but every condemn
      // routes through #condemnIfUnclaimed, which re-checks the claim state LIVE at
      // the destruction -- a blob claimed DURING the (unbounded) hash is never
      // destroyed out from under the reader (CWE-362). Only a blob absent from BOTH
      // blobs/ and claims/ is genuinely missing.
      let blobPath = join(blobDir, id);
      let blobStat;
      try {
        blobStat = await lstat(blobPath);
      } catch (err) {
        _absent(err); // absent from blobs/ (ENOENT); any other errno propagates
        blobPath = join(await this.#containedDir("claims"), id);
        try {
          blobStat = await lstat(blobPath);
        } catch (err2) {
          _absent(err2); // absent from claims/ too -> genuinely missing
          findings.push({ kind: "missing-blob", id });
          if (opts.repair) await this.#condemnIfUnclaimed(id, "missing-blob", repaired);
          continue;
        }
      }
      if (blobStat.size !== entry.size) {
        findings.push({ kind: "size-mismatch", id });
        if (opts.repair) await this.#condemnIfUnclaimed(id, "size-mismatch", repaired);
        continue;
      }
      let got;
      try {
        got = await this.#hashBlob(blobPath, algoOf(entry.digest));
      } catch (err) {
        if (err instanceof RefNotFound) continue; // vanished mid-walk (a claim committed / a drop)
        if (err instanceof IntegrityError) { // a symlink / non-regular blob, refused
          findings.push({ kind: "digest-mismatch", id });
          if (opts.repair) await this.#condemnIfUnclaimed(id, "digest-mismatch", repaired);
          continue;
        }
        throw err;
      }
      if (!constantTimeEqual(got.digest, entry.digest)) {
        findings.push({ kind: "digest-mismatch", id });
        if (opts.repair) await this.#condemnIfUnclaimed(id, "digest-mismatch", repaired);
      }
    }

    // blobs/: orphan blobs (no sidecar), stale .tmp orphans, foreign files.
    const blobScan = await this.#containedDir("blobs");
    for (const name of await readdir(blobScan)) {
      if (await this.#auditOrphanTmp("blobs", blobScan, name, now, opts, findings, repaired)) continue; // an in-flight push or orphaned .tmp
      if (!isValid(name)) {
        findings.push({ kind: "foreign-file", id: null });
        if (opts.repair) await this.#discard("blobs", name, "foreign-file", repaired);
        continue;
      }
      if (scanned.has(name)) continue; // a sidecar in the meta snapshot vouches for it
      // No sidecar in the snapshot -- but write() renames the blob to its FINAL
      // name BEFORE the sidecar lands, so an in-flight push is indistinguishable
      // from an orphan by name alone. Condemn ONLY an AGED blob whose sidecar and
      // claim are BOTH absent LIVE: a fresh blob gets the same grace the .tmp
      // branch gives a streaming write (it may be the post-rename/pre-sidecar
      // window of a live push), and a live sidecar/claim is a healthy entry the
      // snapshot missed -- never delete a just-written blob (CWE-367).
      let orphanStat;
      try { orphanStat = await lstat(join(blobScan, name)); } catch (err) { _absent(err); continue; }
      if (now - orphanStat.mtimeMs < C.AUDIT.TMP_GRACE_MS) continue; // fresh -- a possibly-in-flight push
      if (await this.#isPresent(join(await this.#containedDir("meta"), name + ".json"))) continue; // sidecar landed after the snapshot
      if (await this.#isPresent(join(await this.#containedDir("claims"), name))) continue; // claimed after the snapshot
      findings.push({ kind: "orphan-blob", id: name });
      if (opts.repair) await this.#condemn(name, "orphan-blob", repaired);
    }

    // claims/: stale claims are REPORTED, never repaired (deleting a restorable
    // claim would be data loss; SPEC.md 6 recovery owns resolution).
    const claimsDir = await this.#containedDir("claims");
    for (const name of await readdir(claimsDir)) {
      if (await this.#auditOrphanTmp("claims", claimsDir, name, now, opts, findings, repaired)) continue; // an orphaned .tmp (claims/ writes none in normal flow)
      if (!isValid(name)) {
        findings.push({ kind: "foreign-file", id: null });
        if (opts.repair) await this.#discard("claims", name, "foreign-file", repaired);
        continue;
      }
      let claimStat;
      try { claimStat = await lstat(join(claimsDir, name)); } catch (err) { _absent(err); continue; }
      if (now - claimStat.mtimeMs >= opts.claimTimeoutMs) findings.push({ kind: "stale-claim", id: name });
    }

    // tombstones/: replication's graves. verify audits the dir for layout damage --
    // a foreign name is loud, an aged .tmp is an orphan -- AND audits each grave's
    // CONTENTS through the same parser tombstones()/prune() use.
    const tombstonesDir = await this.#containedDir("tombstones");
    for (const name of await readdir(tombstonesDir)) {
      if (await this.#auditOrphanTmp("tombstones", tombstonesDir, name, now, opts, findings, repaired)) continue;
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : null;
      if (id === null || !isValid(id)) {
        findings.push({ kind: "foreign-file", id: null });
        if (opts.repair) await this.#discard("tombstones", name, "foreign-file", repaired);
        continue;
      }
      // A valid-ref-named grave whose CONTENTS fail the parser (bit rot, tampering, an
      // id that mismatches its filename) makes both tombstones() and prune() loud with
      // no other repair path -- so verify owns its recovery, condemning it under repair.
      // A grave holds no restorable bytes (unlike a stale claim), so removing a corrupt
      // one is pure cleanup, never data loss. An I/O fault is loud, not a finding.
      try {
        await this.#readTombstone(join(tombstonesDir, name), id);
      } catch (err) {
        if (err instanceof RefNotFound) continue; // vanished mid-scan (a concurrent prune)
        if (!(err instanceof IntegrityError)) throw err;
        findings.push({ kind: "corrupt-tombstone", id });
        if (opts.repair) {
          await this.removeTombstone(id);
          repaired.push({ kind: "corrupt-tombstone", id });
        }
      }
    }

    // delivered/: the burn-only observation markers (SPEC.md 6). A marker whose claim
    // is gone is inert -- ids never repeat, so it can never gate a future recovery --
    // but it is layout residue, so report and reap it; a foreign name is corruption,
    // loud, like every other dir.
    const deliveredDir = await this.#containedDir("delivered");
    const claimsForDelivered = await this.#containedDir("claims");
    for (const name of await readdir(deliveredDir)) {
      if (await this.#auditOrphanTmp("delivered", deliveredDir, name, now, opts, findings, repaired)) continue;
      if (!isValid(name)) {
        findings.push({ kind: "foreign-file", id: null });
        if (opts.repair) await this.#discard("delivered", name, "foreign-file", repaired);
        continue;
      }
      if (await this.#isPresent(join(claimsForDelivered, name))) continue; // its claim still stands
      findings.push({ kind: "orphan-delivered", id: name });
      if (opts.repair) await this.#discard("delivered", name, "orphan-delivered", repaired);
    }

    return { scanned: scanned.size, findings, repaired };
  }

  // writeTombstone(id, tombstone) -> void. FIRST-WRITE-WINS, race-safe. Two
  // destroyers of ONE id run concurrently in a single process with NO claim mutex
  // between them -- drop takes no claim, so drop||drop, drop||pop, and clear||pop all
  // reach here at once (the claim only serializes pop-vs-pop). So the commit cannot be
  // #writeAtomic's shared `<id>.json.tmp`+rename: two writers collide on that tmp under
  // O_EXCL (the loser throws a raw, path-bearing EEXIST out of drop/pop), and rename
  // silently REPLACES on Windows (verified) -- clobbering the first grave's destroyedAt,
  // a resurrection of the grave (SPEC.md 4.2, 4.4). Instead: write to a UNIQUE tmp, then
  // `link` it to the grave name -- the claim path's exclusivity primitive. link NEVER
  // overwrites, so a racer's EEXIST IS the first write winning (swallowed, not an error)
  // and no destroyedAt is ever clobbered. The random tmp suffix means two writers never
  // collide on the tmp, and a crashed writer's tmp is a harmless orphan (verify reaps
  // it), never a wedge. FILE_MODE; contained.
  async writeTombstone(id, tombstone) {
    assertValid(id);
    const dir = await this.#containedDir("tombstones");
    const finalPath = join(dir, id + ".json");
    if (await this.#isPresent(finalPath)) return; // a grave already stands -- first-write-wins
    // The policy layer hands a makeTombstone() object -- exactly { id, destroyedAt,
    // cause } -- so serialize it whole; a malformed shape would be caught on read.
    const bytes = Buffer.from(JSON.stringify(tombstone), "utf8");
    const tmpPath = join(dir, id + ".json." + randomBytes(8).toString("hex") + ".tmp");
    const fh = await open(tmpPath, "wx", FILE_MODE);
    try {
      try {
        await _writeAll(fh, bytes, 0);
        await fh.sync();
      } finally {
        await fh.close();
      }
      // link, not rename: a concurrent destroyer's grave is NEVER overwritten, so its
      // EEXIST is first-write-wins (a no-op here), not a raw error escaping drop/pop.
      await _retryTransient(() => link(tmpPath, finalPath));
    } catch (err) {
      if (!(err && err.code === "EEXIST")) throw err; // a real fs fault -- the tmp is reaped below
    } finally {
      await rm(tmpPath, { force: true }); // our unique tmp is transient whether we won or lost
    }
  }

  // hasTombstone(id) -> boolean. Presence ONLY (lstat, no-follow): a grave -- even
  // a corrupt or symlinked one -- refuses resurrection, so store()'s step-2 need
  // not parse it (fail-closed in the safe direction; a corrupt grave still blocks).
  async hasTombstone(id) {
    assertValid(id);
    return this.#isPresent(join(await this.#containedDir("tombstones"), id + ".json"));
  }

  // listTombstones() -> Tombstone[]. Loud, not lossy (the list() discipline): a
  // foreign name in tombstones/ or a corrupt grave FAILS the listing. Each grave
  // is read through the contained, symlink-refused open, bounded before parse,
  // shape- and id-checked. A grave that vanished between the readdir and its read
  // (a concurrent prune) is simply no longer listed, exactly as list() tolerates.
  async listTombstones() {
    const dir = await this.#containedDir("tombstones");
    const out = [];
    for (const name of await readdir(dir)) {
      if (name.endsWith(".tmp")) continue; // an in-flight grave write
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : null;
      if (id === null || !isValid(id)) throw new IntegrityError("store layout is damaged");
      try {
        out.push(await this.#readTombstone(join(dir, name), id));
      } catch (err) {
        if (err instanceof RefNotFound) continue; // vanished mid-scan -- no longer a grave
        throw err;
      }
    }
    return out;
  }

  // removeTombstone(id) -> boolean (was one held). ttl pruning. force AND recursive
  // so a tampered directory-shaped grave is reaped too; rm removes a
  // final-component symlink itself, never following it (CWE-59). The presence is
  // read BEFORE the removal for the boolean (rm's force would swallow the ENOENT).
  async removeTombstone(id) {
    assertValid(id);
    const path = join(await this.#containedDir("tombstones"), id + ".json");
    const had = await this.#isPresent(path);
    await _retryTransient(() => rm(path, { force: true, recursive: true }));
    return had;
  }

  // #readTombstone(path, id) -> Tombstone. Read and strictly validate a grave from
  // its OWN descriptor: no-follow open, bounded read BEFORE parse, JSON.parse under
  // a corruption verdict, exact shape + id match through the schema home -- the
  // hostile-sidecar discipline, retargeted to the smaller grave. onAbsent is
  // RefNotFound so listTombstones can tolerate a grave pruned mid-scan.
  async #readTombstone(path, id) {
    const fh = await this.#openStored(path, () => new RefNotFound(), "tombstone storage shape is damaged");
    try {
      if ((await fh.stat()).size > MAX_TOMBSTONE_BYTES) throw new IntegrityError("tombstone exceeds its size bound");
      let parsed;
      try {
        parsed = JSON.parse(await fh.readFile("utf8"));
      } catch {
        throw new IntegrityError("tombstone is not valid JSON");
      }
      assertTombstoneShape(parsed, IntegrityError);
      if (!constantTimeEqual(parsed.id, id)) throw new IntegrityError("tombstone identity mismatch");
      return parsed;
    } finally {
      await fh.close();
    }
  }

  // claim(id) -> { entry, source }. Atomically claim the blob into claims/<id>
  // and stream from there. The mutex is `link`, NOT `rename`: link FAILS with
  // EEXIST when a claim already exists, so exactly one of two racing pops wins;
  // rename would SILENTLY REPLACE the destination and -- a real Windows behavior
  // (verified) -- let both "win". The blob is one inode reachable from two names
  // (blobs/<id> and claims/<id>) only across the link->unlink below; the sidecar
  // stays in meta/, so a claimed entry is a sidecar in meta/ plus a blob in
  // claims/. A reader during that narrow window still opens blobs/<id> and reads
  // the inode; the claim-aware read path condemns a claimed blob once blobs/<id>
  // is unlinked, which is the state every non-racing reader observes.
  async claim(id) {
    assertValid(id);
    const blobDir = await this.#containedDir("blobs");
    const claimsDir = await this.#containedDir("claims");
    const claimPath = join(claimsDir, id);
    // The claim mutex (link) runs BEFORE reading the sidecar: a loser rejects
    // RefClaimed at the link without ever opening the sidecar, so it never races
    // the winner's consumeRead sidecar rewrite -- renaming over an open file is
    // EPERM on Windows. Only the winner reads the sidecar, below.
    try {
      // _retryTransient absorbs a Windows EPERM against the just-pushed blob's
      // lingering handle; EEXIST (already claimed) and ENOENT (blob gone) pass
      // straight through to the verdicts below.
      await _retryTransient(() => link(join(blobDir, id), claimPath));
    } catch (err) {
      // EEXIST: another pop already claimed it. ENOENT: the blob left blobs/ (a
      // committed pop, or a drop) -- disambiguate (fragile area 1), never report
      // not-found without checking the claim first.
      if (err && err.code === "EEXIST") throw new RefClaimed();
      if (err && err.code === "ENOENT") {
        try {
          await lstat(claimPath);
        } catch (probe) {
          _absent(probe);
          throw new RefNotFound();
        }
        throw new RefClaimed();
      }
      throw err;
    }
    // Won the claim: drop the original name; the blob now lives only at claims/<id>.
    await _retryTransient(() => rm(join(blobDir, id), { force: true }));
    // A fresh claim starts with NO delivery state (the memory backend's fresh-record
    // semantics): clear any residual marker so a budgeted id re-claimed after a prior read
    // cannot inherit that read's delivered flag. The read path records delivery for THIS
    // claim only after the mark is durably written and before the first byte is released.
    await rm(join(await this.#containedDir("delivered"), id), { force: true });
    // link does not touch mtime, so stamp claimedAt explicitly -- otherwise every
    // claim on an older entry would look instantly stale to recovery (fragile
    // area 3). A crash in the window before this leaves the old mtime, which
    // recovery resolves per policy -- both directions are the configured policy.
    // lutimes, NOT utimes: a hostile blobs/<id> symlink is hard-linked into
    // claims/ as a link to the symlink, and a path utimes would FOLLOW it and
    // touch the target's timestamps OUTSIDE the store. lutimes stamps the link
    // itself; the #openStored below then rejects the symlinked claim (O_NOFOLLOW),
    // so the tamper never bends the store's no-follow discipline.
    // From here the blob lives ONLY at claims/<id>. If any step below fails before
    // a source is handed back -- a drop removing the sidecar so stat RefNotFounds,
    // a corrupt sidecar, a tampered claim blob -- #claimedRead never receives a
    // source to run its restore/burn verdict, so the claim would orphan a blob
    // that blocks later reads as claimed and holds maxTotal until a future run's
    // recovery. Undo the claim best-effort (restore returns a live entry to
    // blobs/, or cleans up a dropped one), then surface the original failure.
    try {
      const claimedAt = Date.now();
      await lutimes(claimPath, new Date(claimedAt), new Date(claimedAt));
      const entry = await this.stat(id); // the winner reads the sidecar (present)
      const damaged = "claimed blob storage shape is damaged";
      const fh = await this.#openStored(claimPath, () => new IntegrityError(damaged), damaged);
      return { entry, source: fh.createReadStream() };
    } catch (err) {
      await this.restore(id).catch(() => {});
      throw err;
    }
  }

  // restore(id) -> void. Return a claimed blob claims/<id> -> blobs/<id>. POSIX
  // rename overwrites silently, so an occupied blobs/<id> would resurrect
  // destroyed data (monotone violation, SPEC.md 4.2) -- refused UNLESS the
  // occupant is the SAME inode as the claim, which is an interrupted claim (a
  // crash after link() before the original name was removed left a duplicate
  // link): the entry is already live, so the redundant claim name is dropped. A
  // different inode is genuine corruption (fragile area 7). A missing claim is
  // RefNotFound.
  async restore(id) {
    assertValid(id);
    const claimsDir = await this.#containedDir("claims");
    // The claim is being resolved either way (restored to blobs/, or its drop
    // finished), so drop its delivered marker; force makes the common no-marker case
    // (a restore-policy store, or a claim that never delivered a byte) a no-op.
    await rm(join(await this.#containedDir("delivered"), id), { force: true });
    // A drop during the claim destroys the entry by unlinking its sidecar,
    // orphaning the claimed blob. Restoring that blob into blobs/ would resurrect
    // bytes for an entry that no longer exists (SPEC 4.2 monotone) -- the same
    // contract the memory backend's remove states: a restore of a dropped claim
    // MUST find nothing. So finish the drop's destruction (remove the orphaned
    // claimed blob) and report the entry gone. Any restore runs after the read
    // has settled -- onFail/onCommit fire once the stream ends -- so the claimed
    // blob is closed here and removing it races nothing.
    const metaDir = await this.#containedDir("meta");
    try {
      await lstat(join(metaDir, id + ".json"));
    } catch (err) {
      _absent(err);
      await rm(join(claimsDir, id), { force: true });
      throw new RefNotFound();
    }
    const blobDir = await this.#containedDir("blobs");
    const blobPath = join(blobDir, id);
    let occupant = null;
    try {
      occupant = await lstat(blobPath);
    } catch (err) {
      _absent(err); // blobs/<id> is free -- proceed to the rename below
    }
    if (occupant) {
      // blobs/<id> is occupied. If it is the SAME file as the claim (sameFile: dev
      // +ino, guarded against a Windows ino:0 collision by size+birthtime), the
      // process died after link() but before removing the original name -- an
      // interrupted claim leaves a duplicate link. The entry is already live at
      // blobs/<id>, so complete the recovery by dropping the redundant claim name
      // (never a rename onto itself). A DIFFERENT file is a genuine occupied target
      // -- two blobs for one unique id -- corruption, refused. A claim gone here is
      // RefNotFound.
      let claimed;
      try {
        claimed = await lstat(join(claimsDir, id));
      } catch (err) {
        _absent(err);
        throw new RefNotFound();
      }
      if (sameFile(occupant, claimed)) {
        await rm(join(claimsDir, id), { force: true });
        return;
      }
      throw new IntegrityError("restore target is occupied");
    }
    try {
      await _retryTransient(() => rename(join(claimsDir, id), blobPath));
    } catch (err) {
      if (_absent(err)) throw new RefNotFound();
      throw err;
    }
    // Re-check the sidecar AFTER the move: the check above and this rename are not
    // atomic, so a drop that removes the sidecar in that window would leave the
    // restored blob as an unreferenced orphan -- invisible to stat/list and never
    // reclaimed by recovery (its scan is claim-driven, and this blob is no longer
    // a claim), a permanent leak under repeated races. If the entry vanished,
    // finish the destruction the drop began by removing the blob we just moved.
    try {
      await lstat(join(metaDir, id + ".json"));
    } catch (err) {
      _absent(err);
      await rm(blobPath, { force: true });
      throw new RefNotFound();
    }
  }

  // commit(id) -> void. Destroy a claimed entry: sidecar first, then the claimed
  // blob -- the same delete order as remove(), so a crash between them leaves a
  // claim without a sidecar, which recovery reads as an interrupted commit and
  // COMPLETES (never restores a sidecar-less blob into blobs/). Force-removes,
  // so it is idempotent -- which is what lets recovery finish a partial commit
  // (fragile area 6).
  async commit(id) {
    assertValid(id);
    const metaDir = await this.#containedDir("meta");
    // recursive: a corrupt sidecar can be DIRECTORY-shaped (or a symlink), not the normal
    // regular file -- recovery finishing a destruction over such corruption must still
    // reap it (matching verify's repair, which uses the same recursive rm), or commit
    // throws EISDIR, the claim stands, and every later verb re-runs recovery and re-fails.
    // `rm` removes a final-component symlink ITSELF, never following it (CWE-59/367);
    // recursive is inert on a regular file.
    await rm(join(metaDir, id + ".json"), { force: true, recursive: true });
    const claimsDir = await this.#containedDir("claims");
    // The claimed blob's read stream may have only just closed; on Windows its
    // handle can linger, so absorb the transient EPERM rather than fail the
    // commit (force already makes an already-gone blob a no-op -- idempotent). recursive
    // for the same directory-shaped-corruption tolerance as the sidecar above.
    await _retryTransient(() => rm(join(claimsDir, id), { force: true, recursive: true }));
    // The claim is gone; drop its delivered marker too (force: a no-op when none was
    // written -- only 'burn' reads write one).
    await rm(join(await this.#containedDir("delivered"), id), { force: true });
  }

  // listClaims() -> { id, claimedAt, delivered }[]. The recovery scan's input. Same
  // name discipline as list(): a foreign name in claims/ is corruption, .tmp is
  // invisible, and a claim that vanished between the readdir and its lstat (a
  // concurrent restore/commit) has simply left -- skipped, not failed. claimedAt
  // is the mtime the claim stamped.
  async listClaims() {
    const claimsDir = await this.#containedDir("claims");
    const deliveredDir = await this.#containedDir("delivered");
    const out = [];
    for (const name of await readdir(claimsDir)) {
      if (name.endsWith(".tmp")) continue;
      if (!isValid(name)) throw new IntegrityError("store layout is damaged");
      let claimedAt;
      try {
        // Floor to integer milliseconds: on filesystems with sub-millisecond
        // mtime precision, mtimeMs is a float, but claimedAt is a Date.now()-style
        // ms timestamp -- the same integer-ms contract the memory backend returns
        // and recovery compares against claimTimeout.
        claimedAt = Math.floor((await lstat(join(claimsDir, name))).mtimeMs);
      } catch (err) {
        _absent(err);
        continue;
      }
      // `delivered` is a persistent marker file (delivered/<id>) the read path drops
      // when the first byte reaches a consumer under 'burn' (SPEC.md 6); its presence
      // survives the crash that orphaned the claim, so recovery can tell an observed
      // read from an unobserved one and restore rather than destroy never-read data.
      const delivered = await this.#isPresent(join(deliveredDir, name));
      out.push({ id: name, claimedAt, delivered });
    }
    return out;
  }

  // markDelivered(id) -> void. Record, PERSISTENTLY, that a byte of this claim reached
  // a consumer (SPEC.md 6, 9). An empty marker at delivered/<id>: recovery reads its
  // presence to decide burn (observed) vs restore (never observed). Idempotent (a "w"
  // create truncates a re-mark), contained, and metadata-durable exactly as the claim
  // link is -- the read path calls it only under 'burn', before it hands over the byte.
  async markDelivered(id) {
    assertValid(id);
    // No claim, nothing to gate: a mark must never resurrect a marker for a claim that has
    // been resolved (and, for a budgeted id, re-claimed) -- so it is a no-op unless the
    // claim still stands, mirroring the memory backend's flag-on-the-live-record semantics.
    const claimsDir = await this.#containedDir("claims");
    if (!(await this.#isPresent(join(claimsDir, id)))) return;
    const deliveredDir = await this.#containedDir("delivered");
    // O_NOFOLLOW | O_NONBLOCK, the discipline every other open in this backend holds: a
    // planted symlink at the marker path is refused (CWE-59), never followed to truncate an
    // out-of-store target, and a planted FIFO cannot park the open. O_CREAT | O_TRUNC keeps
    // a re-mark idempotent.
    const flags = FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | (FS.O_NOFOLLOW || 0) | (FS.O_NONBLOCK || 0);
    const fh = await open(join(deliveredDir, id), flags, FILE_MODE);
    await fh.close();
  }

  // isClaimed(id) -> boolean. Advisory: is a live claim held on this id right now?
  // A single lstat of claims/<id>, no sidecar open -- apply/pop probe this before
  // their advisory stat so a contended reader rejects RefClaimed without opening
  // the sidecar the claim-holder is rewriting (on Windows an open reader blocks
  // that rename-replace, which livelocks the holder). Recovery resolves stale
  // claims before the probe runs, so a present claim is a live one.
  async isClaimed(id) {
    assertValid(id);
    const claimsDir = await this.#containedDir("claims");
    try {
      await lstat(join(claimsDir, id));
      return true;
    } catch (err) {
      _absent(err);
      return false;
    }
  }

  // consumeRead(id) -> remaining. Debit one read credit and return what is left.
  // Only ever called while holding the claim -- the claim is the cross-process
  // mutex, so no two readers race the decrement. spend() owns the arithmetic (no
  // readsLeft literal here -- the guard-shape tripwire). The sidecar is rewritten
  // atomically over the old one; persisting BEFORE the caller restores the blob
  // means a crash after this leaves a correctly-decremented entry, so a completed
  // drain is always paid for (fragile area 5).
  async consumeRead(id) {
    assertValid(id);
    const metaDir = await this.#containedDir("meta");
    const sidecarPath = join(metaDir, id + ".json");
    const damaged = "sidecar storage shape is damaged";
    // ONE descriptor for the read AND the rewrite: the open is the atomicity
    // anchor. A concurrent drop that removes the sidecar BEFORE this open ENOENTs
    // (RefNotFound -- the debit never recreates a dropped entry); one that removes
    // it AFTER unlinks the name while this descriptor keeps the now-nameless
    // inode, so the debit lands on a ghost and no dropped entry is resurrected
    // (SPEC 4.2 monotone). A tmp+rename would instead recreate the name a
    // concurrent drop had just removed. spend() owns the arithmetic (no readsLeft
    // literal here -- the guard-shape tripwire). Persisting the debit before the
    // caller restores the blob means a crash after this leaves a correctly
    // decremented entry, so a completed drain is always paid for (fragile area 5).
    const fh = await this.#openStored(sidecarPath, () => new RefNotFound(), damaged, WRITE_FLAGS);
    try {
      const next = spend(await this.#readSidecar(fh, id));
      const bytes = Buffer.from(JSON.stringify(next), "utf8");
      // In-place rewrite through the anchored descriptor: truncate, then write
      // the WHOLE buffer from offset 0 (looping short writes) and fsync. A crash
      // mid-write leaves a short/corrupt sidecar, which the next read rejects as
      // IntegrityError -- fail-closed and loud, never silently bad.
      await fh.truncate(0);
      await _writeAll(fh, bytes, 0);
      await fh.sync();
      return next.readsLeft;
    } finally {
      await fh.close();
    }
  }
}
