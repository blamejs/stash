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
 *   A `Stash` is an `EventEmitter`. It emits `'pushed'` (Entry) after a push
 *   commits, `'popped'` (Entry) after a pop's delete lands, `'dropped'` (Entry)
 *   on `drop` / `clear` / a budget-exhausting read, `'expired'` (Entry) exactly
 *   once per reaped entry, and `'sweepError'` (Error) -- never `'error'`, which
 *   would crash the process -- when a background sweep throws. Payloads are full,
 *   defensive-copy Entry objects emitted after the change commits, so a throwing
 *   listener cannot unwind the committed operation.
 *
 * @card
 *   The policy layer -- push bytes in for a random-capability ref, stream
 *   them back out, destroy on demand; write-once entries, fail-closed
 *   verdicts.
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Transform, pipeline } from "node:stream";

import { C } from "./constants.js";
import { parse } from "./duration.js";
import { isExpired, make } from "./entry.js";
import { IntegrityError, RefClaimed, RefNotFound, SizeExceeded, StashFull } from "./errors.js";
import { assertValid, constantTimeEqual, generate } from "./ref.js";
import { parse as parseSize } from "./size.js";
import { oneOf, options, plainObject } from "./validate.js";

// Constructor options the spec defines but a shipped milestone does not yet
// implement. Accepting one silently would fail open (an operator who set
// maxSize believes it is enforced), so each throws at config time until its
// milestone lands (validate.options enforces it). SPEC.md 12 is the
// delivery plan; the policy layer names the lists, validate owns the
// mechanism.
const UNIMPLEMENTED_OPTIONS = [
  "tombstoneTtl",
];

const UNIMPLEMENTED_PUSH_OPTIONS = [];

// The backend surface Stash drives today. Validated at construction so a
// misassembled backend fails at boot, not at first push.
const REQUIRED_BACKEND_METHODS = [
  "write", "read", "remove", "stat", "list", "stats", "verify",
  "claim", "restore", "commit", "listClaims", "consumeRead", "isClaimed",
];

// onPopFailure resolves a pop (or a budgeted read) that fails to fully drain
// with a matching digest: 'restore' (default) returns the entry so the read can
// be retried; 'burn' destroys it anyway -- opt-in paranoia for a caller who
// treats an attempted read as an observed one.
const ON_POP_FAILURE = ["restore", "burn"];

// A claim older than this is treated as a prior run's abandoned pop and resolved
// per onPopFailure by the lazy recovery scan; a younger one is another live
// process's pop, left alone. A duration string (one consumer) resolved through
// duration.parse -- not a constants.js scale literal.
const DEFAULT_CLAIM_TIMEOUT = "10m";

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
// updated as chunks flow and compared -- timing-safe -- when the source ends; a
// mismatch errors the stream with IntegrityError instead of delivering silently
// bad bytes. Streaming: nothing is buffered.
//
// `verdict` (optional) drives the claimed-read lifecycle for pop and budgeted
// apply. `onCommit()` runs in flush on a full drain with a matching digest --
// BEFORE the transform signals end, so a consumer that has seen 'end' knows the
// destruction (or budget debit) has already committed; no test needs to poll.
// `onFail()` runs exactly once on the OTHER outcomes -- a digest mismatch, a
// source error, or a premature destroy -- to restore or burn the claim. The
// `resolved` latch guarantees the verdict fires exactly once even though flush
// and the pipeline callback can both reach it (fragile area 11). An unbudgeted,
// unclaimed apply passes no verdict and behaves exactly as before.
function _verifiedStream(entry, source, verdict) {
  const hash = createHash("sha256");
  let resolved = false;
  const verify = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
    async flush(callback) {
      const got = "sha256:" + hash.digest("hex");
      if (!constantTimeEqual(got, entry.digest)) {
        resolved = true;
        if (verdict && verdict.onFail) await _settle(verdict.onFail);
        callback(new IntegrityError());
        return;
      }
      if (verdict && verdict.onCommit) {
        resolved = true;
        // onCommit runs to completion BEFORE the callback signals end, so a
        // consumer that has seen 'end' knows the commit landed. Convert its
        // outcome to an Error-or-null (`.then(ok, fail)`, no catch to misread as
        // fail-open) and hand it straight to the single flush callback: a commit
        // fault surfaces on the stream, and recovery resolves the still-standing
        // claim later.
        callback(await verdict.onCommit().then(() => null, (err) => err));
        return;
      }
      callback();
    },
  });
  // pipeline propagates source errors into `verify` and destroys both sides; the
  // consumer observes every failure on the returned stream. A failure that
  // reaches here without flush having resolved (a source error, a premature
  // destroy at N%) still owes the claim its verdict.
  pipeline(source, verify, (err) => {
    if (err && !resolved && verdict && verdict.onFail) {
      resolved = true;
      void _settle(verdict.onFail);
    }
  });
  return verify;
}

// Run a claim-resolution hook, swallowing its own failure: a restore/burn that
// cannot land must not throw into a stream teardown or an unhandledRejection. A
// claim it leaves standing is exactly what the lazy recovery scan resolves on
// the next construction over the store.
async function _settle(hook) {
  // Drop-silent by design (drift rule 8's one sanctioned outlet): a restore/burn
  // that cannot land must not throw into a stream teardown or an
  // unhandledRejection. A claim it leaves standing is exactly what the lazy
  // recovery scan resolves on the next construction. The hook is an async call,
  // so its rejection routes through `.catch`, never a synchronous throw.
  await hook().catch(() => {});
}

// _dispose(source) -- best-effort teardown of an opened backend read source we
// are abandoning (the entry lapsed between the expiry gate and the open). It
// destroys the source and swallows a teardown error, but does NOT wait for a
// 'close' event: a Readable configured with `emitClose: false` -- which the
// SPEC.md 9 backend contract permits -- emits neither 'close' nor 'error' on
// destroy, so waiting would hang apply forever. Waiting is unnecessary anyway:
// the backend owns its descriptor's close, and the following remove() unlinks
// the name regardless of a still-closing handle (POSIX unlink-while-open;
// Windows opens share delete).
function _dispose(source) {
  if (!source || typeof source.destroy !== "function" || source.destroyed) return;
  source.once("error", () => {}); // abandoning it -- a teardown error is not ours to surface
  source.destroy();
}

// _boundedSource(source, maxSize, residual) -- wrap a push's chunk source so the
// size limits are enforced DURING the stream, in the policy layer, never in a
// backend. Each chunk is converted to a Buffer first (so a multibyte string is
// counted as its encoded bytes, and the counted bytes are exactly the bytes
// yielded to the backend), the running total is checked BEFORE the chunk is
// yielded, and the typed verdict is thrown the instant a bound is crossed -- so
// the crossing chunk never reaches the backend's tmp file and an unbounded
// source is abandoned at the boundary rather than drained. maxSize is the
// per-entry bound, `residual` the remaining stash-wide headroom (maxTotal minus
// what is already stored); either is null for "no bound". SizeExceeded is
// reported before StashFull when one chunk crosses both: a per-entry overflow is
// a permanent verdict a retry can't fix, while a full stash may later clear.
// True for a raw ArrayBuffer or SharedArrayBuffer from ANY realm. Buffer.from()
// stores these by their byteLength, so _boundedSource must measure them that way
// -- a bare `instanceof ArrayBuffer` misses SharedArrayBuffer and a buffer from
// another realm (Worker, vm), which would then fall through to `.length`
// (undefined -> the size check is skipped while Buffer.from still writes every
// byte). The brand check is realm-proof and never trips a get/index trap, so a
// hostile array-like Proxy is still measured by its own `.length`, not copied.
function _isArrayBuffer(value) {
  if (value === null || typeof value !== "object") return false;
  const tag = Object.prototype.toString.call(value);
  return tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]";
}

async function* _boundedSource(source, maxSize, residual) {
  let total = 0;
  for await (const chunk of source) {
    // Measure the chunk's byte length WITHOUT copying it, so a single hostile
    // oversized chunk is rejected before it is duplicated in memory -- the
    // advertised limit has to bound this allocation too, not just what is
    // written. A string measures its UTF-8 byte length; an ArrayBuffer (or
    // SharedArrayBuffer), a typed array, or a DataView measures byteLength --
    // a raw buffer has no `.length` (reading it as chunk.length is undefined ->
    // NaN -> every bound comparison false), and a multi-byte typed array's
    // `.length` counts elements, not bytes; either would slip an oversized chunk
    // past the check. Any other array-like falls back to `.length`. Measurement
    // and the copy below classify each chunk identically, so the bytes counted
    // are exactly the bytes Buffer.from writes.
    let len;
    if (typeof chunk === "string") len = Buffer.byteLength(chunk);
    else if (ArrayBuffer.isView(chunk)) len = chunk.byteLength;
    else if (_isArrayBuffer(chunk)) len = chunk.byteLength;
    else len = chunk.length;
    total += len;
    if (maxSize !== null && total > maxSize) throw new SizeExceeded();
    if (residual !== null && total > residual) throw new StashFull();
    // Materialize the chunk only now that it is known to fit, over its EXACT
    // bytes: a typed array or a byte-offset view is normalized through its
    // backing buffer so its real bytes are stored, not its element values
    // reinterpreted (Buffer.from(uint16array) would copy each element mod 256).
    if (typeof chunk === "string") yield Buffer.from(chunk, "utf8");
    else if (ArrayBuffer.isView(chunk)) yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    else yield Buffer.from(chunk);
  }
}

// _positiveBytes(value, label) -- a byte bound (maxSize / maxTotal): a size
// string or byte count resolved through size.parse, then required to be a
// POSITIVE safe integer. A zero or negative limit would reject every push, so
// it's a config-time TypeError rather than a silently-broken bound. null/absent
// means no bound.
function _positiveBytes(value, label) {
  const bytes = parseSize(value, label);
  if (bytes !== null && bytes <= 0) {
    throw new TypeError(label + ": must be a positive size; 0 would reject every push");
  }
  return bytes;
}

// _positiveCount(value, label) -- a count bound (maxEntries): a positive safe
// integer, no string form (it's a count, not a size or duration). null/absent
// means no bound; zero or negative is a config-time TypeError.
function _positiveCount(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(label + ": expected a positive integer count");
  }
  return value;
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
 *
 * `opts.maxSize` bounds each entry (a size string like `'100mb'` or a byte
 * count); a push that exceeds it aborts mid-stream with `SizeExceeded`, leaving
 * no partial behind. `opts.maxEntries` and `opts.maxTotal` bound the whole
 * store; a push that would exceed either is refused with `StashFull`, and
 * nothing existing is evicted to make room. Expired-but-unswept entries are
 * pruned before the store is judged full, so they never block a live push. A
 * stats read and the write are not atomic, so concurrent pushes can overshoot a
 * stash-wide bound by the number in flight -- the bound stops unbounded growth,
 * not that exact byte. `maxTotal` counts the stored footprint -- each blob plus
 * its metadata, not the blob alone -- so many tiny blobs carrying large `meta`
 * cannot slip past it. It is a ceiling you set, not one the disk enforces: size
 * it below the backing partition's free space (and keep `maxSize` at or below
 * it), or the filesystem fills before the limit fires.
 *
 * `opts.onPopFailure` decides what happens to an entry whose `pop` (or budgeted
 * `apply`) fails to fully drain -- a stream destroyed early, a source error, a
 * digest mismatch: `'restore'` (the default) returns the entry so the read can
 * be retried, `'burn'` destroys it anyway. `opts.claimTimeout` (a duration
 * string or a number of ms, default `'10m'`, and strictly POSITIVE) is how long
 * a claim left by a crashed process is treated as still live before recovery
 * reclaims it on the next construction; a claim younger than this is left
 * untouched. Recovery cannot tell a crashed reader's claim from a legitimately
 * slow live one, so set `claimTimeout` ABOVE the longest `pop`/budgeted read a
 * deployment can run, and keep a disk root to a single writing process -- a
 * claim held past the lease by a concurrent instance would be reclaimed out from
 * under the live reader. A non-positive `claimTimeout` is refused at
 * construction. Spec options whose milestone has not shipped (`tombstoneTtl`)
 * throw a TypeError at construction rather than sitting silently unenforced.
 *
 * @example
 *   import { Stash } from "@blamejs/stash";
 *   import { MemoryBackend } from "@blamejs/stash/backends/memory";
 *
 *   const stash = new Stash({ backend: new MemoryBackend(), ttl: "24h" });
 */
export class Stash extends EventEmitter {
  #backend;
  #ttlMs = null;
  #sweepTimer = null;
  #sweepInFlight = null;
  #maxSize = null;
  #maxTotal = null;
  #maxEntries = null;
  #onPopFailure = "restore";
  #claimTimeoutMs = 0;
  // The lazy crash-recovery scan, memoized: resolved on the first public verb
  // (never in the constructor -- constructors do no I/O), mirroring the disk
  // backend's #init retry-on-failure memo. The memo is re-run once a claim it
  // skipped for being younger than the lease would have aged past it -- #nextRecoverAt
  // is the earliest such deadline (Infinity when the scan resolved everything).
  #recovered = null;
  #nextRecoverAt = 0;

  constructor(opts) {
    super();
    options(opts, "new Stash", {
      allowed: ["backend", "ttl", "sweepInterval", "maxSize", "maxEntries", "maxTotal", "onPopFailure", "claimTimeout"],
      unimplemented: UNIMPLEMENTED_OPTIONS,
    });
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
    // A ttl can be a valid duration yet place expiresAt (createdAt + ttl) past
    // the safe integer range, which make() refuses at push. Catch an unusable
    // DEFAULT here, against the current clock, so a bad configuration fails at
    // construction -- not silently on every later push.
    if (this.#ttlMs !== null && !Number.isSafeInteger(Date.now() + this.#ttlMs)) {
      throw new TypeError("new Stash: ttl places expiresAt beyond the safe integer range");
    }
    // Size and count bounds, resolved and validated before the sweep timer is
    // armed so a malformed bound throws without leaving a timer behind.
    this.#maxSize = _positiveBytes(opts.maxSize, "maxSize");
    this.#maxTotal = _positiveBytes(opts.maxTotal, "maxTotal");
    this.#maxEntries = _positiveCount(opts.maxEntries, "maxEntries");
    // A per-entry cap larger than the whole-store cap can never bind: an empty
    // store admits at most maxTotal bytes, so a maxSize above it is dead
    // configuration. Refuse it at boot rather than accept a check that never
    // fires (SPEC.md 8.2).
    if (this.#maxSize !== null && this.#maxTotal !== null && this.#maxSize > this.#maxTotal) {
      throw new TypeError("new Stash: maxSize must not exceed maxTotal -- a per-entry cap above the whole-store cap can never bind");
    }
    // Pop lifecycle: onPopFailure is a closed enum (restore | burn), claimTimeout
    // the crash-recovery staleness threshold. Both validated at config time -- an
    // unrecognized policy or a NaN threshold is a silently-disabled recovery scan.
    this.#onPopFailure = opts.onPopFailure === undefined
      ? "restore"
      : oneOf(opts.onPopFailure, "new Stash: onPopFailure", ON_POP_FAILURE);
    const claimTimeout = opts.claimTimeout === undefined ? DEFAULT_CLAIM_TIMEOUT : opts.claimTimeout;
    this.#claimTimeoutMs = parse(claimTimeout, "claimTimeout");
    // Strictly POSITIVE: recovery reclaims a claim older than this as a crashed
    // prior run's, so a zero (or negative) lease would treat an active pop as
    // instantly abandoned and let recovery restore/burn it out from under a live
    // reader -- the once-only read guarantee gone. The lease must exceed the
    // longest pop a deployment can run (see the constructor docs).
    if (this.#claimTimeoutMs === null || this.#claimTimeoutMs <= 0) {
      throw new TypeError("new Stash: claimTimeout must be a positive duration");
    }
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
    // A rejected background sweep must never become an unhandledRejection (fatal
    // on Node -- the exact outcome SPEC.md 4.3 exists to prevent): surface it as
    // 'sweepError', NEVER 'error' (an unhandled 'error' crashes the process; a
    // janitor must not be able to take the app down). With zero listeners this is
    // a no-op -- only 'error' is fatal. A 'sweepError' listener that ITSELF throws
    // is contained by the trailing `.catch`, so its throw can neither escape as an
    // unhandledRejection nor leave the guard below unreached -- a stuck guard would
    // silently disable the janitor for the process's life (every later tick a
    // no-op). The chain therefore always fulfils, so the flag always clears -- no
    // try/finally to misread as a fail-open swallow. A throwing sweepError handler
    // is dropped here (drift-rule-8 tier-3 sink -- the one sanctioned silent drop).
    await work.catch((err) => this.emit("sweepError", err)).catch(() => {});
    this.#sweepInFlight = null;
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
      // The remove that returns true is the single 'I destroyed it' witness, so a
      // lazy reap racing the sweeper emits 'expired' exactly once (the loser sees
      // false). No in-process once-set to desync from the fs truth (SPEC.md 4.3).
      if (await this.#backend.remove(ref)) this.#emit("expired", entry);
      throw new RefNotFound();
    }
    return entry;
  }

  // #emit(event, entry) -- emit a lifecycle event with a DEFENSIVE COPY of the
  // Entry (SPEC.md 4.3): a listener that mutates its payload must never reach a
  // subsequent show()/list(). The single place the copy is made, so no emit site
  // can leak a live Entry reference. Emits fire at the verb layer, AFTER the state
  // change commits, so M7's store() stays silent by construction (no bypass flag).
  #emit(event, entry) {
    this.emit(event, structuredClone(entry));
  }

  // #rejectIfClaimed(ref) -- the claim gates contended access to an entry's
  // mutable state, not just its bytes. A live claim means a pop or budgeted read
  // holds the entry, so a concurrent reader rejects RefClaimed HERE, before the
  // advisory stat opens the sidecar the holder is rewriting -- on Windows an open
  // reader blocks that rewrite's rename and livelocks the holder. Advisory: the
  // claim's own link is the authoritative mutex, so a claim taken in the window
  // after this probe still serializes correctly -- the loser then rejects at the
  // link instead. #recover(), run first by every verb, clears stale claims, so a
  // hit here is a live claim, not a prior run's debris.
  async #rejectIfClaimed(ref) {
    if (await this.#backend.isClaimed(ref)) throw new RefClaimed();
  }

  // #recover() -- the lazy crash-recovery scan (SPEC.md 6). Memoized so it runs
  // on the first public verb -- never in the constructor (no I/O there) -- and
  // re-runs only once a claim it skipped for being too young would have aged past
  // the lease (see #nextRecoverAt below), not per operation. It resolves every
  // STALE claim: one older than claimTimeout was abandoned by a prior run, while a
  // younger one may be a live pop and is left, then re-checked once it ages. A
  // claim whose sidecar is gone is an
  // interrupted commit -- recovery FINISHES the deletion (never restores a
  // sidecar-less blob into the store, fragile area 6); otherwise the entry is
  // resolved per onPopFailure ('burn' destroys, 'restore' returns it). It drives
  // backend methods only, so it cannot recurse into a public verb. A failed scan
  // clears the memo so the next verb retries, mirroring the disk backend's #init.
  #recover() {
    // Re-run once a claim a prior scan skipped for being younger than the lease
    // would have aged past it: memoizing forever would strand a claim that looked
    // live at the first op (a crash within claimTimeout) as ECLAIMED until a
    // restart. The memo stays shared until #nextRecoverAt, so concurrent ops still
    // run one scan; a scan that resolves everything sets the deadline to Infinity.
    if (this.#recovered !== null && Date.now() < this.#nextRecoverAt) return this.#recovered;
    this.#nextRecoverAt = Infinity; // claim this re-scan for concurrent ops to share
    this.#recovered = (async () => {
      const claims = await this.#backend.listClaims();
      const now = Date.now();
      let nextAt = Infinity;
      for (const { id, claimedAt } of claims) {
        const staleAt = claimedAt + this.#claimTimeoutMs;
        if (now < staleAt) { // still within the lease -- maybe a live pop; leave it,
          nextAt = Math.min(nextAt, staleAt); // but re-scan once it would age past the lease
          continue;
        }
        let hasSidecar = true;
        try {
          await this.#backend.stat(id);
        } catch (err) {
          if (err instanceof RefNotFound) hasSidecar = false;
          else throw err;
        }
        // Resolve the stale claim, tolerating one that ANOTHER process's recovery
        // over the same root already resolved between our listClaims and here: two
        // simultaneous starts can list the same stale claim, and the loser's
        // restore then finds it gone (RefNotFound) or its target already restored
        // (IntegrityError). Recovery's contract is only that no stale claim REMAINS,
        // so the verdict is the claim's presence: if it is gone the work is done --
        // swallow the fault; a claim still standing after a failed restore/commit is
        // a real fault, propagated to clear the memo for a retry.
        try {
          if (!hasSidecar || this.#onPopFailure === "burn") {
            await this.#backend.commit(id);
          } else {
            await this.#backend.restore(id);
          }
        } catch (err) {
          if (await this.#backend.isClaimed(id)) throw err;
        }
      }
      this.#nextRecoverAt = nextAt;
    })().catch((err) => {
      this.#recovered = null;
      this.#nextRecoverAt = 0;
      throw err;
    });
    return this.#recovered;
  }

  // #claimedRead(ref, onCommit) -- the ONE claimed-read path, shared by pop and
  // budgeted apply (SPEC.md 4.1 "same commit path", drift rule 6a). Claim the
  // entry (the claim serializes concurrent readers; the loser gets RefClaimed
  // from the backend), re-check expiry on the CLAIMED entry -- the authoritative
  // check, since a TTL can lapse between the advisory pre-check and winning the
  // claim (fragile area 4) -- then stream it digest-verified. A full drain with a
  // matching digest runs `onCommit(claimedEntry)`; any other outcome (mismatch,
  // error, premature destroy) restores the claim, or burns it under
  // onPopFailure: 'burn'. pop and budgeted apply differ only in onCommit, so the
  // destruction/restore machinery has exactly one home.
  async #claimedRead(ref, onCommit) {
    const { entry, source } = await this.#backend.claim(ref);
    if (isExpired(entry, Date.now())) {
      _dispose(source);
      await this.#backend.restore(ref);
      if (await this.#backend.remove(ref)) this.#emit("expired", entry); // lazy-drop, witnessed
      throw new RefNotFound();
    }
    return _verifiedStream(entry, source, {
      onCommit: () => onCommit(entry),
      onFail: () => (this.#onPopFailure === "burn"
        ? this.#backend.commit(ref)
        : this.#backend.restore(ref)),
    });
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
   * no expiry); an absent `ttl` inherits the default. `opts.reads` is a read
   * budget: a positive integer count of successful `apply` drains after which
   * the entry self-destructs (`null`, the default, is unlimited). A budgeted
   * `apply` spends one credit only on a full, digest-verified drain -- an
   * abandoned or corrupted read costs nothing -- and the read that takes the
   * budget to zero destroys the entry. Terms are fixed at push and only move the
   * entry toward destruction -- there is no touch or extend.
   * The ref is random -- a capability, not a content address. Construct-time
   * `maxSize` bounds this entry (`SizeExceeded`, thrown mid-stream), and
   * `maxEntries` / `maxTotal` bound the whole store (`StashFull`); a rejected
   * push leaves nothing behind.
   *
   * @example
   *   const ref = await stash.push(ciphertext, { meta: { kind: "drop" }, ttl: "1h" });
   */
  async push(source, opts = {}) {
    options(opts, "push", { allowed: ["meta", "ttl", "reads"], unimplemented: UNIMPLEMENTED_PUSH_OPTIONS });
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
    // reads (null = unlimited) is the entry's read budget; make() validates it as
    // a positive integer or null at this single construction site.
    const reads = opts.reads === undefined ? null : opts.reads;
    const chunks = _toChunkSource(source);
    await this.#recover();
    // Stash-wide bounds, enforced in the policy layer before the backend stores
    // a byte. maxEntries is a hard pre-check (a new entry always adds one) and
    // rejects before the stream starts. maxTotal is enforced mid-stream against
    // the residual headroom (see _boundedSource). Both are expiry-aware: a
    // backend counts every stored entry, expired or not, so provably-expired
    // entries are reclaimed BEFORE the store is judged full -- otherwise a
    // dead-but-unswept entry inflates the footprint and rejects a live push,
    // including in the band below maxTotal where the new entry's sidecar alone
    // would tip it over. Only the bounded path pays this; an unlimited stash
    // reads neither prune nor stats. The stats read and the write are not
    // atomic; concurrent pushes can overshoot by the in-flight count, which
    // bounds the overshoot without a lock the sidecar design omits.
    const id = generate();
    const entry = make(id, meta, ttlMs, reads);
    let residual = null;
    if (this.#maxEntries !== null || this.#maxTotal !== null) {
      await this.prune();
      const stats = await this.#backend.stats();
      if (this.#maxEntries !== null && stats.entries >= this.#maxEntries) {
        throw new StashFull();
      }
      if (this.#maxTotal !== null) {
        // maxTotal bounds the stored footprint -- blob plus sidecar -- so this
        // entry's own metadata is charged against the headroom before the blob
        // streams. Without it, a caller slips unbounded `meta` (or an endless
        // run of zero-byte blobs, each still costing a sidecar) past the limit.
        // The stored sidecar serializes this entry with `size`/`digest` filled in
        // after the write, so this under-counts by those fixed fields -- a bounded
        // sub-100-byte overshoot on the last admitted entry, never the meta -- and
        // never over-counts, so it can't reject an entry that would have fit.
        const sidecarBytes = Buffer.byteLength(JSON.stringify(entry));
        residual = this.#maxTotal - stats.bytes - sidecarBytes;
        if (residual < 0) throw new StashFull();
      }
    }
    const bounded = _boundedSource(chunks, this.#maxSize, residual);
    const stored = await this.#backend.write(id, bounded, entry);
    this.#emit("pushed", stored); // after the write commits (SPEC.md 4.3)
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
   * An entry pushed with a read budget (`reads`) is instead claimed for the
   * read: concurrent readers serialize through the claim (the loser rejects
   * `RefClaimed`), one credit is spent only on a full, digest-verified drain,
   * and the read that exhausts the budget destroys the entry through the same
   * path as `pop`. An unbudgeted entry stays lock-free and pays nothing for the
   * feature.
   *
   * @example
   *   const readable = await stash.apply(ref);
   *   for await (const chunk of readable) sink.write(chunk);
   */
  async apply(ref) {
    assertValid(ref);
    await this.#recover();
    await this.#rejectIfClaimed(ref); // a contended reader bails before opening the sidecar
    const entry = await this.#statLive(ref);
    // A budgeted entry (reads !== null) serializes through the claim mechanism --
    // two concurrent reads cannot both spend the last credit -- and spends one
    // credit ONLY on a full drain with a matching digest (an abandoned or failed
    // read costs nothing). The read that takes readsLeft to zero destroys the
    // entry through the SAME commit path as pop. An unbudgeted entry stays
    // lock-free and pays nothing for the feature.
    if (entry.reads !== null) {
      return this.#claimedRead(ref, async (claimed) => {
        if (claimed.readsLeft === 1) {
          await this.#backend.commit(ref); // the last credit: destroy through the commit path
          this.#emit("dropped", claimed); // budget-exhaust is a 'dropped', NOT a 'popped' (SPEC.md 4.3)
        } else {
          await this.#backend.consumeRead(ref); // persist the debit BEFORE restoring (fragile area 5)
          await this.#backend.restore(ref); // a non-terminal read destroys nothing -- no event
        }
      });
    }
    const source = await this.#backend.read(ref);
    // The gate above and this open are two awaits apart, so a short TTL can
    // lapse in between -- opening a read on a live entry that is expired by the
    // time the stream would be handed out. Re-check at serve time: an entry
    // expired NOW is dropped in passing, never served. The verdict is fixed
    // here, synchronously before the return; an entry that lapses mid-drain
    // afterward is not killed mid-stream (the read is claimed at this point).
    if (isExpired(entry, Date.now())) {
      _dispose(source);
      // Reap in passing on the same remove-witness the lazy gate uses: this is a
      // third 'expired' emit site (alongside #statLive and #claimedRead), so an
      // entry that lapses in the stat->read window is still audited exactly once
      // (the loser of a sweep race sees false) -- never reaped silently (SPEC.md 4.3).
      if (await this.#backend.remove(ref)) this.#emit("expired", entry);
      throw new RefNotFound();
    }
    return _verifiedStream(entry, source);
  }

  /**
   * @primitive  stash.pop
   * @signature  stash.pop(ref) -> Promise<Readable>
   * @since      0.1.7
   * @status     experimental
   * @spec       SPEC.md 4, SPEC.md 6, FIPS 180-4
   * @defends    CWE-362, CWE-367, CWE-354
   * @related    stash.apply, stash.drop
   *
   * Read an entry's bytes and destroy it: the stream is digest-verified as it
   * drains, and the entry is deleted the instant it drains cleanly -- bytes out
   * once, then gone. Pop ignores any read budget; it is terminal by definition.
   *
   * The claim is atomic at the filesystem: two concurrent `pop(ref)` race on the
   * claim, exactly one wins and drains, the other rejects `RefClaimed`
   * (`ECLAIMED`). A stream that errors, is destroyed early, or fails its digest
   * is resolved by `onPopFailure` -- `'restore'` (default) returns the entry so
   * the read can be retried, `'burn'` destroys it anyway. An unknown, expired, or
   * already-claimed ref rejects (`RefNotFound` / `RefClaimed`); a malformed ref
   * dies at the whitelist with `InvalidRef` before any storage access.
   *
   * @example
   *   const readable = await stash.pop(ref); // drains, then the entry is gone
   *   for await (const chunk of readable) sink.write(chunk);
   */
  async pop(ref) {
    assertValid(ref);
    await this.#recover();
    await this.#rejectIfClaimed(ref); // a concurrent pop's loser bails before the advisory stat
    await this.#statLive(ref); // advisory: reject an expired entry with zero claim taken
    return this.#claimedRead(ref, async (entry) => {
      await this.#backend.commit(ref);
      this.#emit("popped", entry); // a pop's terminal delete committed (SPEC.md 4.3)
    });
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
    await this.#recover();
    return this.#statLive(ref);
  }

  /**
   * @primitive  stash.has
   * @signature  stash.has(ref) -> Promise<boolean>
   * @since      0.1.8
   * @status     experimental
   * @spec       SPEC.md 4, SPEC.md 5, SPEC.md 7
   * @related    stash.show, stash.list
   *
   * Existence check without the try/catch `show` needs. `true` for a live entry,
   * `false` for an unknown OR expired ref -- an expired entry is reaped in passing,
   * exactly as `show`/`apply` treat it. A malformed ref still dies at the whitelist
   * with `InvalidRef` BEFORE any backend access -- a boolean query is not a licence
   * to fail open on hostile input -- and a corrupt entry throws `IntegrityError`
   * rather than answering `false`: a clean boolean must never hide corruption.
   *
   * @example
   *   if (await stash.has(ref)) console.log("still present");
   */
  async has(ref) {
    assertValid(ref);
    await this.#recover();
    try {
      await this.#statLive(ref);
      return true;
    } catch (err) {
      if (err instanceof RefNotFound) return false;
      throw err; // IntegrityError / fs faults propagate -- never absorbed into false
    }
  }

  /**
   * @primitive  stash.stats
   * @signature  stash.stats() -> Promise<{ entries, bytes, claimed }>
   * @since      0.1.8
   * @status     experimental
   * @spec       SPEC.md 4, SPEC.md 9
   * @related    stash.list, stash.verify
   *
   * Aggregate counts, never refs: `entries` (live plus expired-but-unswept),
   * `bytes` (the stored footprint -- each blob plus its metadata), and `claimed`
   * (in-flight pop / budgeted-read claims). The object carries exactly those three
   * keys. Aggregates are the physical truth of the shelf: an expired entry still
   * counts until a read or `prune()` reaps it, so it is a fast lstat walk. A
   * foreign file in the layout fails the aggregate loudly with `IntegrityError`,
   * never a silently smaller number; content integrity (a corrupt sidecar, a
   * bit-flipped blob) is `verify()`'s job, not this count's.
   *
   * @example
   *   const { entries, bytes, claimed } = await stash.stats();
   */
  async stats() {
    await this.#recover();
    return this.#backend.stats();
  }

  /**
   * @primitive  stash.verify
   * @signature  stash.verify(opts?) -> Promise<Report>
   * @since      0.1.8
   * @status     experimental
   * @spec       SPEC.md 4, FIPS 180-4
   * @related    stash.stats, stash.prune
   *
   * Audit the store's physical integrity. Dry-run by default: it digest-checks
   * every blob (streamed, never a full-blob read) and reports damage --
   * `digest-mismatch`, `size-mismatch`, `corrupt-sidecar`, `missing-blob`,
   * `orphan-blob`, `orphan-tmp`, `foreign-file`, `stale-claim` -- without touching
   * anything. `{ repair: true }` removes ONLY what it condemns (a damaged entry's
   * blob and sidecar together); healthy entries survive byte-identical, a fresh
   * push's in-flight `.tmp` is spared, and a stale claim is reported but never
   * deleted (resolving it is crash recovery's job -- deleting a restorable claim
   * would be data loss). The Report is `{ scanned, findings: [{ kind, id }],
   * repaired: [{ kind, id }] }`; `id` is the ref for ref-shaped damage (the store
   * is the embedder's) and `null` for a foreign name -- verify never echoes an
   * on-disk path. Damage is a FINDING; an I/O fault (a permission denial, a
   * vanished layout dir) THROWS -- a walk error absorbed into a clean report would
   * be fail-open. Repair is local until replication (a condemnation writes no
   * tombstone yet -- M7).
   *
   * @example
   *   const report = await stash.verify();      // dry run: report only
   *   await stash.verify({ repair: true });     // remove the condemned
   */
  async verify(opts = {}) {
    options(opts, "verify", { allowed: ["repair"] });
    if (opts.repair !== undefined && typeof opts.repair !== "boolean") {
      throw new TypeError("verify: repair must be a boolean");
    }
    await this.#recover();
    // claimTimeout is policy (M5), passed down so the backend can age a stale
    // claim without owning the lifecycle threshold; the tmp grace is C.AUDIT.
    return this.#backend.verify({ repair: opts.repair === true, claimTimeoutMs: this.#claimTimeoutMs });
  }

  // [Symbol.asyncIterator] -- `for await (const entry of stash)` is sugar over
  // list(): the live entries, expired ones filtered, contents never yielded.
  // Documented on the list() primitive; a Symbol method has no dotted name for
  // its own wiki page. Iterating an empty stash completes at once.
  async *[Symbol.asyncIterator]() {
    for (const entry of await this.list()) yield entry;
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
    // A boolean switch, validated as one: a truthy non-boolean (e.g. the string
    // "false" from a config parse) must not silently expose the expired entries
    // the default hides. Fail loud at config time, never fail open.
    if (opts.includeExpired !== undefined && typeof opts.includeExpired !== "boolean") {
      throw new TypeError("list: includeExpired must be a boolean");
    }
    await this.#recover();
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
   * whitelist. A corrupt entry is still removed -- drop deletes without reading,
   * so a sidecar too damaged to parse never blocks cleanup; it carries no
   * lifecycle event (there is no whole Entry to hand a listener). `verify` is the
   * audit path that classifies the damage.
   *
   * @example
   *   await stash.drop(ref); // true -- gone
   */
  async drop(ref) {
    assertValid(ref);
    await this.#recover();
    // stat BEFORE remove for the Entry payload; the remove-returns-false witness
    // covers the vanish race (a concurrent drop/pop). An expired entry is
    // nonexistent on every public surface (SPEC.md 7), so dropping one reaps it as
    // 'expired' and returns false -- only a LIVE removal is a 'dropped' true.
    let entry;
    try {
      entry = await this.#backend.stat(ref);
    } catch (err) {
      if (err instanceof RefNotFound) return false;
      // A sidecar too corrupt to parse must not make the entry un-droppable: drop
      // deletes without reading (unlike show/has, which surface the corruption).
      // Destroy it and report the removal; there is no whole Entry to carry, so no
      // event fires -- verify({ repair: true }) is the richer audit path.
      if (err instanceof IntegrityError) return this.#backend.remove(ref);
      throw err;
    }
    const expired = isExpired(entry, Date.now());
    if (!(await this.#backend.remove(ref))) return false; // vanished between stat and remove
    this.#emit(expired ? "expired" : "dropped", entry);
    return !expired;
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
    await this.#recover();
    const entries = await this.#backend.list();
    const now = Date.now();
    // Destroy EVERYTHING first, recording each removal and its cause, and emit only
    // once the whole clear has committed: a lifecycle listener that throws must not
    // abort the loop and strand the un-visited entries (an event observes a
    // completed state change, it never interrupts one -- SPEC.md 4.3). A live entry
    // is 'dropped' and counts; an expired one is 'expired' and does not (it was
    // already nonexistent, SPEC.md 4.3, 7).
    const reaped = [];
    let destroyed = 0;
    for (const entry of entries) {
      const expired = isExpired(entry, now);
      if (await this.#backend.remove(entry.id)) {
        reaped.push([expired ? "expired" : "dropped", entry]);
        if (!expired) destroyed += 1;
      }
    }
    for (const [event, entry] of reaped) this.#emit(event, entry);
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
    // prune is a public verb AND the background sweep's operation, so it carries
    // the same first-operation recovery every other verb does: a sweep-only
    // deployment must still resolve a prior run's stale claims (restore/burn per
    // onPopFailure), not leave claimed bytes occupying the store until some other
    // verb happens to run. #recover drives backend methods only, so this cannot
    // recurse into prune; it is memoized, so the sweep runs it just once.
    await this.#recover();
    const entries = await this.#backend.list();
    const now = Date.now();
    // Reap every expired entry FIRST, emit only after: a throwing 'expired'
    // listener must not abort the reap and strand the rest (this runs on the sweep
    // timer, where a stranded expired entry would linger until a lazy read finds
    // it). An entry a concurrent drop removed first fails the remove-witness and is
    // never double-counted (SPEC.md 4.3).
    const reaped = [];
    for (const entry of entries) {
      if (isExpired(entry, now) && await this.#backend.remove(entry.id)) reaped.push(entry);
    }
    for (const entry of reaped) this.#emit("expired", entry);
    return reaped.length;
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
