// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
/**
 * @module     stash
 * @nav        Core
 * @title      Stash
 * @order      10
 * @slug       stash
 *
 * @intro
 *   The policy layer of the store. `Stash` owns identity (refs), lifecycle,
 *   and integrity; the backend it wraps owns bytes. You put bytes in with
 *   `push` and get a ref back -- a 256-bit random capability, not a content
 *   address. You read them back with `apply`, inspect with `show` / `list`,
 *   and destroy with `drop` / `clear`.
 *
 *   The verb set is `git stash`'s, and the correspondence is the contract:
 *   lifecycle verbs the git command doesn't have don't get added, and the
 *   ones it has don't get renamed. Entries are write-once and their
 *   lifecycle is monotone -- every state change moves an entry closer to
 *   destruction, never further.
 *
 *   The store is crypto-agnostic by architecture: there is no key parameter
 *   on any method and no cipher import anywhere in the tree. Encryption
 *   belongs to the consumer; StashJS is a shelf.
 *
 * @card
 *   The policy layer -- push bytes in for a random-capability ref, stream
 *   them back out, destroy on demand; write-once entries, fail-closed
 *   verdicts.
 */

import { createHash } from "node:crypto";
import { Transform, pipeline } from "node:stream";

import { make } from "./entry.js";
import { IntegrityError } from "./errors.js";
import { assertValid, constantTimeEqual, generate } from "./ref.js";
import { options, plainObject } from "./validate.js";

// Constructor options the spec defines but a shipped milestone does not yet
// implement. Accepting one silently would fail open (an operator who set
// maxSize believes it is enforced), so each throws at config time until its
// milestone lands (validate.options enforces it). SPEC.md 12 is the
// delivery plan; the policy layer names the lists, validate owns the
// mechanism.
const UNIMPLEMENTED_OPTIONS = [
  "ttl",
  "maxSize",
  "maxEntries",
  "maxTotal",
  "onPopFailure",
  "tombstoneTtl",
  "sweepInterval",
  "claimTimeout",
];

const UNIMPLEMENTED_PUSH_OPTIONS = ["ttl", "reads"];

// The backend surface Stash drives today. Validated at construction so a
// misassembled backend fails at boot, not at first push.
const REQUIRED_BACKEND_METHODS = ["write", "read", "remove", "stat", "list"];

// Normalize a push source to an async-iterable of byte chunks, or throw a
// config-time TypeError. Accepted: Buffer | Uint8Array | string | Readable |
// AsyncIterable. Never buffers -- a stream source passes through as-is.
function _toChunkSource(source) {
  if (typeof source === "string") return [Buffer.from(source, "utf8")];
  if (Buffer.isBuffer(source)) return [Buffer.from(source)];
  if (source instanceof Uint8Array) return [Buffer.from(source)];
  if (source !== null && typeof source === "object" && Symbol.asyncIterator in source) {
    return source;
  }
  throw new TypeError("push: source must be a Buffer, Uint8Array, string, Readable, or AsyncIterable");
}

// Wrap a backend read stream in a digest-verifying passthrough. The hash is
// updated as chunks flow and compared -- timing-safe -- when the source
// ends; a mismatch errors the stream with IntegrityError instead of
// delivering silently bad bytes. Streaming: nothing is buffered.
function _verifiedStream(entry, source) {
  const hash = createHash("sha256");
  const verify = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      const got = "sha256:" + hash.digest("hex");
      if (constantTimeEqual(got, entry.digest)) callback();
      else callback(new IntegrityError());
    },
  });
  // pipeline propagates source errors into `verify` and destroys both sides;
  // the consumer observes every failure on the returned stream, so the
  // callback has nothing left to report.
  pipeline(source, verify, () => {});
  return verify;
}

/**
 * @primitive  stash.Stash
 * @signature  new Stash(opts) -> Stash
 * @since      0.1.0
 * @status     experimental
 * @spec       SPEC.md 4
 * @defends    CWE-1188
 * @related    stash.backends.MemoryBackend
 *
 * Construct a store over a backend. `opts.backend` is required and must
 * implement the backend contract (SPEC.md 9). Spec options whose milestone
 * has not shipped (`ttl`, `maxSize`, `maxEntries`, `maxTotal`,
 * `onPopFailure`, `tombstoneTtl`, `sweepInterval`) throw a TypeError at
 * construction rather than sitting silently unenforced.
 *
 * @example
 *   import { Stash } from "@blamejs/stash";
 *   import { MemoryBackend } from "@blamejs/stash/backends/memory";
 *
 *   const stash = new Stash({ backend: new MemoryBackend() });
 */
export class Stash {
  #backend;

  constructor(opts) {
    options(opts, "new Stash", { allowed: ["backend"], unimplemented: UNIMPLEMENTED_OPTIONS });
    const backend = opts.backend;
    if (backend === null || typeof backend !== "object") {
      throw new TypeError("new Stash: a backend is required");
    }
    for (const method of REQUIRED_BACKEND_METHODS) {
      if (typeof backend[method] !== "function") {
        throw new TypeError("new Stash: backend is missing '" + method + "'");
      }
    }
    this.#backend = backend;
  }

  /**
   * @primitive  stash.push
   * @signature  stash.push(source, opts) -> Promise<string>
   * @since      0.1.0
   * @status     experimental
   * @spec       SPEC.md 4, SPEC.md 5, FIPS 180-4, RFC 4648, RFC 8259
   * @defends    CWE-330, CWE-400
   * @related    stash.apply, stash.show, stash.drop
   *
   * Store bytes; resolve to the entry's ref. The source may be a Buffer, a
   * Uint8Array, a UTF-8 string, a Readable, or any AsyncIterable of chunks;
   * it streams through to the backend, which computes size and sha256
   * digest as the bytes pass. `opts.meta` is a caller-owned plain object,
   * round-tripped verbatim as JSON and never interpreted. The ref is
   * random -- a capability, not a content address.
   *
   * @example
   *   const ref = await stash.push(ciphertext, { meta: { kind: "drop" } });
   */
  async push(source, opts = {}) {
    options(opts, "push", { allowed: ["meta"], unimplemented: UNIMPLEMENTED_PUSH_OPTIONS });
    let meta = {};
    if (opts.meta !== undefined) {
      plainObject(opts.meta, "push: meta");
      meta = JSON.parse(JSON.stringify(opts.meta));
    }
    const chunks = _toChunkSource(source);
    const id = generate();
    const stored = await this.#backend.write(id, chunks, make(id, meta));
    return stored.id;
  }

  /**
   * @primitive  stash.apply
   * @signature  stash.apply(ref) -> Promise<Readable>
   * @since      0.1.0
   * @status     experimental
   * @spec       SPEC.md 4, FIPS 180-4
   * @defends    CWE-354, CWE-208
   * @related    stash.push, stash.show
   *
   * Stream an entry's bytes without destroying it. The stream is
   * digest-verified as it drains: a corrupted blob errors the stream with
   * `IntegrityError` rather than delivering silently bad bytes. An unknown
   * ref rejects with `RefNotFound`; a malformed ref dies at the whitelist
   * with `InvalidRef` before any storage access.
   *
   * @example
   *   const readable = await stash.apply(ref);
   *   for await (const chunk of readable) sink.write(chunk);
   */
  async apply(ref) {
    assertValid(ref);
    const entry = await this.#backend.stat(ref);
    const source = await this.#backend.read(ref);
    return _verifiedStream(entry, source);
  }

  /**
   * @primitive  stash.show
   * @signature  stash.show(ref) -> Promise<Entry>
   * @since      0.1.0
   * @status     experimental
   * @spec       SPEC.md 4
   * @related    stash.list, stash.apply
   *
   * Resolve a ref to its Entry -- metadata only, never contents. The Entry
   * is a defensive copy; entries are write-once and nothing a caller does
   * to the returned object changes the store.
   *
   * @example
   *   const entry = await stash.show(ref);
   *   entry.size; // bytes
   */
  async show(ref) {
    assertValid(ref);
    return this.#backend.stat(ref);
  }

  /**
   * @primitive  stash.list
   * @signature  stash.list(opts) -> Promise<Entry[]>
   * @since      0.1.0
   * @status     experimental
   * @spec       SPEC.md 4
   * @related    stash.show, stash.clear
   *
   * List every entry's metadata. Contents never appear; a listing that
   * leaked blob bytes would defeat the point of refs as capabilities.
   *
   * @example
   *   const entries = await stash.list();
   *   entries.length;
   */
  async list(opts = {}) {
    options(opts, "list", { allowed: ["includeExpired"] });
    return this.#backend.list();
  }

  /**
   * @primitive  stash.drop
   * @signature  stash.drop(ref) -> Promise<boolean>
   * @since      0.1.0
   * @status     experimental
   * @spec       SPEC.md 4
   * @related    stash.clear, stash.list
   *
   * Delete an entry without reading it. Resolves `false` when the ref names
   * nothing -- an absent entry is a fact, not a failure. A malformed ref
   * still throws `InvalidRef`; replication input and typos both die at the
   * whitelist.
   *
   * @example
   *   await stash.drop(ref); // true -- gone
   */
  async drop(ref) {
    assertValid(ref);
    return this.#backend.remove(ref);
  }

  /**
   * @primitive  stash.clear
   * @signature  stash.clear() -> Promise<number>
   * @since      0.1.0
   * @status     experimental
   * @spec       SPEC.md 4
   * @related    stash.drop, stash.list
   *
   * Drop everything; resolve to the number of entries destroyed.
   *
   * @example
   *   const destroyed = await stash.clear();
   */
  async clear() {
    const entries = await this.#backend.list();
    let destroyed = 0;
    for (const entry of entries) {
      if (await this.#backend.remove(entry.id)) destroyed += 1;
    }
    return destroyed;
  }
}
