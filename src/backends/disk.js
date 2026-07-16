// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
/**
 * @module     stash.backends
 *
 * (Continuation block: the stash.backends page metadata lives with the
 * memory backend; this file's primitives render on the same page.)
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
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

// absent(err) -> true for ENOENT, rethrows anything else. The one place
// "file not found" legitimately converts to a fact instead of a failure.
function _absent(err) {
  if (err && err.code === "ENOENT") return true;
  throw err;
}

/**
 * @primitive  stash.backends.DiskBackend
 * @signature  new DiskBackend(opts) -> DiskBackend
 * @since      0.1.1
 * @status     experimental
 * @spec       SPEC.md 9, SPEC.md 2.1, RFC 8259
 * @defends    CWE-22, CWE-59, CWE-377, CWE-770, path traversal (CWE-23)
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
 * refused as corruption rather than followed.
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

  // Read a blob's lstat through the corruption lens: a symlink where a
  // blob should be is never followed.
  async #lstatBlob(path) {
    let stats;
    try {
      stats = await lstat(path);
    } catch (err) {
      if (_absent(err)) return null;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new IntegrityError("blob storage shape is damaged");
    }
    return stats;
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
  async write(id, source, entry) {
    assertValid(id);
    const blobDir = await this.#containedDir("blobs");
    const metaDir = await this.#containedDir("meta");
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
      await this.#writeAtomic(metaDir, id + ".json", sidecar);
    } catch (err) {
      await rm(blobPath, { force: true });
      throw err;
    }
    return structuredClone(stored);
  }

  // read(id) -> Readable over the blob. The entry must exist (sidecar
  // present and valid); a sidecar without its blob is corruption.
  async read(id) {
    const entry = await this.stat(id);
    const blobDir = await this.#containedDir("blobs");
    const blobPath = join(blobDir, entry.id);
    const stats = await this.#lstatBlob(blobPath);
    if (stats === null) throw new IntegrityError("blob storage shape is damaged");
    return createReadStream(blobPath);
  }

  // remove(id) -> boolean. Sidecar first (the entry stops existing), then
  // the blob. Absent is a fact, not a failure.
  async remove(id) {
    assertValid(id);
    const metaDir = await this.#containedDir("meta");
    const blobDir = await this.#containedDir("blobs");
    const sidecarPath = join(metaDir, id + ".json");
    let had = true;
    try {
      await lstat(sidecarPath);
    } catch (err) {
      if (_absent(err)) had = false;
    }
    await rm(sidecarPath, { force: true });
    await rm(join(blobDir, id), { force: true });
    return had;
  }

  // stat(id) -> Entry, strictly validated: bounded read, JSON.parse under
  // a corruption verdict, exact shape via the canonical entry module, and
  // the sidecar's own id must be the id addressed.
  async stat(id) {
    assertValid(id);
    const metaDir = await this.#containedDir("meta");
    const sidecarPath = join(metaDir, id + ".json");
    let stats;
    try {
      stats = await lstat(sidecarPath);
    } catch (err) {
      if (_absent(err)) throw new RefNotFound();
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new IntegrityError("sidecar storage shape is damaged");
    }
    if (stats.size > MAX_SIDECAR_BYTES) throw new IntegrityError("sidecar exceeds its size bound");
    const raw = await readFile(sidecarPath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new IntegrityError("sidecar is not valid JSON");
    }
    assertShape(parsed, IntegrityError);
    if (parsed.id !== id) throw new IntegrityError("sidecar identity mismatch");
    return parsed;
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
