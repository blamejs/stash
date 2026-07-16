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

import { C } from "./constants.js";
import { parse } from "./duration.js";
import { isExpired, make } from "./entry.js";
import { IntegrityError, RefNotFound } from "./errors.js";
import { assertValid, constantTimeEqual, generate } from "./ref.js";
import { options, plainObject } from "./validate.js";

// Constructor options the spec defines but a shipped milestone does not yet
// implement. Accepting one silently would fail open (an operator who set
// maxSize believes it is enforced), so each throws at config time until its
// milestone lands (validate.options enforces it). SPEC.md 12 is the
// delivery plan; the policy layer names the lists, validate owns the
// mechanism.
const UNIMPLEMENTED_OPTIONS = [
  "maxSize",
  "maxEntries",
  "maxTotal",
  "onPopFailure",
  "tombstoneTtl",
  "claimTimeout",
];

const UNIMPLEMENTED_PUSH_OPTIONS = ["reads"];

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
 * @spec       SPEC.md 4, SPEC.md 7, SPEC.md 7.1
 * @defends    CWE-1188
 * @related    stash.backends.MemoryBackend
 *
 * Construct a store over a backend. `opts.backend` is required and must
 * implement the backend contract (SPEC.md 9). `opts.ttl` (`'30m'`, `'24h'`,
 * `'7d'`, a number of ms, or `null` for no expiry) is the construct-time
 * default expiry for every push, overridable per call. `opts.sweepInterval`
 * (same duration forms) arms a background `prune()` timer; the timer is
 * `.unref()`'d, so an open `Stash` never holds the process open on exit --
 * still, call `close()` (or `await using`) on shutdown, since an unref'd timer
 * keeps the `Stash` reachable. A `sweepInterval` above Node's ~24.8-day timer
 * ceiling, or of zero, is a config-time TypeError, not a silent busy loop.
 * Spec options whose milestone has not shipped (`maxSize`, `maxEntries`,
 * `maxTotal`, `onPopFailure`, `tombstoneTtl`) throw a TypeError at construction
 * rather than sitting silently unenforced.
 *
 * @example
 *   import { Stash } from "@blamejs/stash";
 *   import { MemoryBackend } from "@blamejs/stash/backends/memory";
 *
 *   const stash = new Stash({ backend: new MemoryBackend(), ttl: "24h" });
 */
export class Stash {
  #backend;
  #ttlMs = null;
  #sweepTimer = null;
  #sweepInFlight = null;

  constructor(opts) {
    options(opts, "new Stash", { allowed: ["backend", "ttl", "sweepInterval"], unimplemented: UNIMPLEMENTED_OPTIONS });
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
    this.#ttlMs = parse(opts.ttl, "ttl");
    const sweepMs = parse(opts.sweepInterval, "sweepInterval");
    if (sweepMs !== null) {
      if (sweepMs <= 0 || sweepMs > C.TIME.MAX_TIMER_MS) {
        throw new TypeError("new Stash: sweepInterval must be a positive duration no larger than " +
          C.TIME.MAX_TIMER_MS + "ms (Node's timer ceiling); for anything rarer, call prune() on your own schedule");
      }
      // Arming a timer is not I/O -- the constructor-does-no-I/O rule holds; the
      // I/O is in the sweep callback. unref() so this never pins the event loop.
      this.#sweepTimer = setInterval(() => { void this.#sweep(); }, sweepMs);
      this.#sweepTimer.unref();
    }
  }

  // #sweep() -- the background tick. #sweepInFlight is BOTH the overlap guard
  // (a non-null value means a prune is still running, so this tick is a no-op --
  // a slow backend + short interval must not stack unbounded concurrent sweeps)
  // AND the promise close() awaits, so disposal is a real boundary: no
  // sweep-side deletion lands after close() resolves. It is a settled-tracker
  // (resolves on success OR failure, never rejects), so close() can await it
  // without inheriting a sweep failure. The sweep swallows any prune rejection:
  // an async setInterval callback that rejects becomes an unhandledRejection,
  // fatal on Node, and a janitor must never take the process down. This is the
  // drift-rule-8 tier-3 drop-silent sink; M6 replaces the silence with the
  // 'sweepError' emit.
  async #sweep() {
    if (this.#sweepInFlight !== null) return;
    const work = this.prune();
    this.#sweepInFlight = work.then(() => {}, () => {});
    try {
      await work;
    } catch { // drop-silent -- by design (allow:catch-return-swallow): a rejected
      // background sweep would become an unhandledRejection, fatal on Node, and a
      // janitor must never take the process down. M6 replaces this silence with
      // the 'sweepError' emit; vector 16 pins survival now.
    } finally {
      this.#sweepInFlight = null;
    }
  }

  // #statLive(ref) -- the shared lazy-expiry gate. stat the entry, and if it is
  // expired drop it in passing (remove BEFORE the throw) and report it as
  // RefNotFound -- an expired entry is never served, even if no sweep ever
  // runs. A remove that fails (a read-only grant, a vanished dir) propagates
  // LOUDLY rather than being swallowed into the not-found verdict: SPEC 2.1
  // says never degrade a denial silently. apply and show both route through
  // here; M5's pop plugs into the same gate.
  async #statLive(ref) {
    const entry = await this.#backend.stat(ref);
    if (isExpired(entry, Date.now())) {
      await this.#backend.remove(ref);
      throw new RefNotFound();
    }
    return entry;
  }

  /**
   * @primitive  stash.push
   * @signature  stash.push(source, opts) -> Promise<string>
   * @since      0.1.0
   * @status     experimental
   * @spec       SPEC.md 4, SPEC.md 5, FIPS 180-4, RFC 4648, RFC 8259
   * @defends    CWE-330
   * @related    stash.apply, stash.show, stash.drop
   *
   * Store bytes; resolve to the entry's ref. The source may be a Buffer, a
   * Uint8Array, a UTF-8 string, a Readable, or any AsyncIterable of chunks;
   * it streams through to the backend, which computes size and sha256
   * digest as the bytes pass. `opts.meta` is a caller-owned plain object,
   * round-tripped verbatim as JSON and never interpreted. `opts.ttl` overrides
   * the constructor default for this entry (`null` overrides a default back to
   * no expiry); an absent `ttl` inherits the default. Terms are fixed at push
   * and only move the entry toward destruction -- there is no touch or extend.
   * The ref is random -- a capability, not a content address.
   *
   * @example
   *   const ref = await stash.push(ciphertext, { meta: { kind: "drop" }, ttl: "1h" });
   */
  async push(source, opts = {}) {
    options(opts, "push", { allowed: ["meta", "ttl"], unimplemented: UNIMPLEMENTED_PUSH_OPTIONS });
    let meta = {};
    if (opts.meta !== undefined) {
      plainObject(opts.meta, "push: meta");
      // meta is stored as its JSON round-trip, and serialization hooks (a
      // Date's toJSON, a caller's own) can change the value's type between
      // the check above and the bytes stored. The value actually stored
      // must hold the same plain-object shape the read path enforces, or
      // the entry lands unreadable.
      const serialized = JSON.stringify(opts.meta);
      meta = plainObject(serialized === undefined ? null : JSON.parse(serialized), "push: meta");
    }
    // Presence-keyed like meta above: an explicit ttl (including null) overrides
    // the constructor default; an absent key inherits it. parse throws a
    // config-time TypeError before anything is stored on a malformed ttl.
    const ttlMs = opts.ttl !== undefined ? parse(opts.ttl, "push: ttl") : this.#ttlMs;
    const chunks = _toChunkSource(source);
    const id = generate();
    const stored = await this.#backend.write(id, chunks, make(id, meta, ttlMs));
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
   * `IntegrityError` rather than delivering silently bad bytes. An unknown OR
   * expired ref rejects with `RefNotFound` -- an expired entry is dropped in
   * passing and never streamed, even if the sweeper has not run; a malformed
   * ref dies at the whitelist with `InvalidRef` before any storage access.
   *
   * @example
   *   const readable = await stash.apply(ref);
   *   for await (const chunk of readable) sink.write(chunk);
   */
  async apply(ref) {
    assertValid(ref);
    const entry = await this.#statLive(ref);
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
   * to the returned object changes the store. An expired ref is dropped in
   * passing and rejects with `RefNotFound`, the same as an unknown one.
   *
   * @example
   *   const entry = await stash.show(ref);
   *   entry.size; // bytes
   */
  async show(ref) {
    assertValid(ref);
    return this.#statLive(ref);
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
   * leaked blob bytes would defeat the point of refs as capabilities. Expired
   * entries are filtered out by default; `list({ includeExpired: true })`
   * includes them. `list` only filters -- it never drops, so an expired entry
   * still appears under `includeExpired` until a read verb or `prune()` reaps
   * it.
   *
   * @example
   *   const entries = await stash.list();
   *   entries.length;
   */
  async list(opts = {}) {
    options(opts, "list", { allowed: ["includeExpired"] });
    const entries = await this.#backend.list();
    if (opts.includeExpired) return entries;
    const now = Date.now();
    return entries.filter((entry) => !isExpired(entry, now));
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

  /**
   * @primitive  stash.prune
   * @signature  stash.prune() -> Promise<number>
   * @since      0.1.5
   * @status     experimental
   * @spec       SPEC.md 4, SPEC.md 7
   * @related    stash.clear, stash.list
   *
   * Destroy expired entries on demand; resolve to the count actually
   * destroyed. Live entries are untouched. The count is real destructions, not
   * the number of expired entries seen -- an entry that a concurrent drop
   * removes first is not double-counted. Loud over corruption: it lists through
   * the backend, whose verdict on a rotten stored entry surfaces rather than
   * being skipped. `sweepInterval` calls this on a timer; without it, a store
   * relies on the lazy read-path gate and whatever `prune()` its owner runs.
   *
   * @example
   *   const reaped = await stash.prune(); // number of expired entries destroyed
   */
  async prune() {
    const entries = await this.#backend.list();
    const now = Date.now();
    let destroyed = 0;
    for (const entry of entries) {
      if (isExpired(entry, now) && await this.#backend.remove(entry.id)) destroyed += 1;
    }
    return destroyed;
  }

  /**
   * @primitive  stash.close
   * @signature  stash.close() -> Promise<void>
   * @since      0.1.5
   * @status     experimental
   * @spec       SPEC.md 7, SPEC.md 7.1
   * @related    stash.prune
   *
   * Stop the background sweep timer. Idempotent -- calling it again, or on a
   * store that never armed a timer, is a no-op, never an error. It stops the
   * janitor and only the janitor: a closed store still serves push, apply, and
   * the rest. `Stash` also implements `Symbol.asyncDispose` as an alias, so
   * `await using stash = new Stash(...)` clears the timer when the block exits,
   * even on throw. Disposal is a real boundary: `close()` also awaits a sweep
   * already in flight, so no background deletion lands after it resolves.
   * Disposal is the real shutdown path -- the sweep timer is `unref()`'d so it
   * never blocks process exit, but it keeps the `Stash` reachable until closed.
   *
   * @example
   *   const stash = new Stash({ backend, sweepInterval: "5m" });
   *   try {
   *     await stash.push(data);
   *   } finally {
   *     await stash.close();
   *   }
   */
  async close() {
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    // Await a sweep already running so no sweep-side mutation lands after
    // close() resolves. Captured first, since the sweep nulls it when it ends;
    // the tracker never rejects, so this never throws.
    const inFlight = this.#sweepInFlight;
    if (inFlight !== null) await inFlight;
  }

  // Symbol.asyncDispose -- the `await using` alias for close() (SPEC.md 7.1).
  // Idempotent by construction, since close() is: disposal running twice is
  // normal, not an error. Additive -- it does NOT replace the unref() rule.
  async [Symbol.asyncDispose]() {
    await this.close();
  }
}
