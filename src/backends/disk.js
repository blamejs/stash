// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
/**
 * @module     stash.backends
 *
 * (Continuation block: the stash.backends page metadata lives with the
 * memory backend; this file's primitives render on the same page.)
 */

import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { C } from "../constants.js";
import { assertShape } from "../entry.js";
import { IntegrityError, InvalidRef, RefNotFound } from "../errors.js";
import { assertValid, isValid } from "../ref.js";
import { options } from "../validate.js";

const SUBDIRS = ["blobs", "meta", "claims", "tombstones"];

// A sidecar is one Entry's JSON: id + counters + caller meta. Far above
// any legitimate sidecar, far below a parser-DoS payload -- a sidecar
// larger than this is rejected unread.
const MAX_SIDECAR_BYTES = 64 * C.BYTES.KIB;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// A stored file is read through its own descriptor: open once, verify the
// descriptor, then read or stream from that same handle. The check and the
// use share one fd, so nothing re-resolves the path between them -- a blob
// or sidecar swapped for a symlink (or a different file) after a path check
// but before the read is the time-of-check/time-of-use class (CWE-367), and
// a path-based read follows the swap. O_NOFOLLOW refuses a symlink where a
// blob or sidecar belongs at open time on POSIX. O_RDONLY is 0.
const READ_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW || 0);

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

// A symlink refused at open (ELOOP, POSIX O_NOFOLLOW) or a non-file the
// open itself rejected (EISDIR on platforms that block opening a directory)
// is store tampering, not absence.
function _openTamper(err) {
  return err && (err.code === "ELOOP" || err.code === "EISDIR");
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
  return !named.isSymbolicLink() &&
    named.dev === opened.dev && named.ino === opened.ino;
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

  constructor(opts) {
    options(opts, "new DiskBackend", { allowed: ["root"] });
    if (typeof opts.root !== "string" || opts.root.length === 0) {
      throw new TypeError("new DiskBackend: root must be a non-empty path string");
    }
    this.#root = resolve(opts.root);
  }

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
  async #openStored(path, onAbsent, damaged) {
    let fh;
    try {
      fh = await open(path, READ_FLAGS);
    } catch (err) {
      if (err && err.code === "ENOENT") throw onAbsent();
      if (_openTamper(err)) throw new IntegrityError(damaged);
      throw err;
    }
    try {
      const opened = await fh.stat();
      if (!opened.isFile()) throw new IntegrityError(damaged);
      if (SYMLINK_GUARD_NEEDED) {
        let named;
        try {
          named = await lstat(path);
        } catch (err) {
          // The name vanished or became unreadable after the open -- it no
          // longer vouches for the descriptor, so refuse rather than serve
          // an unverifiable handle.
          throw _absent(err) ? new IntegrityError(damaged) : err;
        }
        if (!descriptorMatchesName(opened, named)) {
          throw new IntegrityError(damaged);
        }
      }
    } catch (err) {
      await fh.close();
      throw err;
    }
    return fh;
  }

  async #writeAtomic(dir, name, bytes) {
    const tmpPath = join(dir, name + ".tmp");
    const finalPath = join(dir, name);
    const fh = await open(tmpPath, "wx", FILE_MODE);
    try {
      await fh.write(bytes);
      await fh.sync();
    } catch (err) {
      // coverage residual: this arm needs a write/sync fault on an already
      // open descriptor (disk full, EIO) -- reachable only under fault
      // injection; the cleanup contract it shares with the blob path is
      // pinned by the failed-push vectors.
      await fh.close();
      await rm(tmpPath, { force: true });
      throw err;
    }
    await fh.close();
    await rename(tmpPath, finalPath);
    return finalPath;
  }

  // write(id, source, entry) -> Entry. Streams chunks to blobs/<id>.tmp
  // computing size and digest as they pass, fsyncs, renames into place,
  // THEN writes the sidecar -- so a crash at any point leaves either
  // nothing or an invisible blob orphan, never a served half-entry.
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
    const blobDir = await this.#containedDir("blobs");
    const tmpPath = join(blobDir, id + ".tmp");
    const blobPath = join(blobDir, id);
    const hash = createHash("sha256");
    let size = 0;
    const fh = await open(tmpPath, "wx", FILE_MODE);
    try {
      for await (const chunk of source) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        size += buf.length;
        await fh.write(buf);
      }
      await fh.sync();
    } catch (err) {
      await fh.close();
      await rm(tmpPath, { force: true });
      throw err;
    }
    await fh.close();
    await rename(tmpPath, blobPath);

    const stored = structuredClone(entry);
    stored.size = size;
    stored.digest = "sha256:" + hash.digest("hex");
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
    // A blob missing under a present sidecar is corruption, not absence.
    const fh = await this.#openStored(blobPath, () => new IntegrityError(damaged), damaged);
    return fh.createReadStream();
  }

  // remove(id) -> boolean. Sidecar first (the entry stops existing), then
  // the blob. Absent is a fact, not a failure. `rm` unlinks the directory
  // entry itself -- it never follows a final-component symlink -- so the
  // sidecar's existence and its deletion are one operation, not a
  // check-then-use: a swap cannot redirect the unlink to another file.
  async remove(id) {
    assertValid(id);
    // Each directory is contained immediately before its own unlink, not
    // both up front: a resolve-early/use-late gap is the same directory
    // time-of-check/time-of-use window write() closes, so meta resolves
    // right before the sidecar unlink and blobs right before the blob one.
    const metaDir = await this.#containedDir("meta");
    let had = true;
    try {
      await rm(join(metaDir, id + ".json"));
    } catch (err) {
      if (_absent(err)) had = false;
    }
    const blobDir = await this.#containedDir("blobs");
    await rm(join(blobDir, id), { force: true });
    return had;
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
      if (parsed.id !== id) throw new IntegrityError("sidecar identity mismatch");
      return parsed;
    } finally {
      await fh.close();
    }
  }

  // list() -> Entry[]. Loud, not lossy: a sidecar that fails validation
  // fails the listing -- silently skipping corruption would hide it.
  // In-flight .tmp files are invisible by design.
  async list() {
    const metaDir = await this.#containedDir("meta");
    const out = [];
    for (const name of await readdir(metaDir)) {
      if (name.endsWith(".tmp")) continue;
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : null;
      if (id === null || !isValid(id)) throw new IntegrityError("store layout is damaged");
      out.push(await this.stat(id));
    }
    return out;
  }
}
