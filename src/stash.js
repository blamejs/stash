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

import { EventEmitter } from "node:events";
import { Transform, pipeline } from "node:stream";

import { C } from "./constants.js";
import { DEFAULT_DIGEST, algoOf, assertDigestAlgo, digestHash, digestMarker, finalize } from "./digest.js";
import { parse } from "./duration.js";
import { assertShape, isExpired, make, makeTombstone } from "./entry.js";
import { IntegrityError, RefClaimed, RefNotFound, SizeExceeded, StashFull } from "./errors.js";
import { assertValid, constantTimeEqual, generate } from "./ref.js";
import { parse as parseSize } from "./size.js";
import { oneOf, options, plainObject } from "./validate.js";

// No push option is spec'd-but-unimplemented; the constructor's last such option
// (tombstoneTtl) landed with M7, so the reject-unimplemented mechanism retires --
// every spec'd option is now enforced (SPEC.md 12's delivery plan is complete for
// the config surface). A future breaking option would re-introduce a list here.
const UNIMPLEMENTED_PUSH_OPTIONS = [];

// tombstoneTtl default: a grave is pruned after this window (SPEC.md 4.4). It must
// comfortably exceed the longest gap between reconciliations, or a forgotten
// tombstone lets an id come back -- the floor rule the deployment owns (documented,
// not enforceable: StashJS cannot know the sync schedule). `null` never prunes.
const DEFAULT_TOMBSTONE_TTL = "30d";

// The backend surface Stash drives today. Validated at construction so a
// misassembled backend fails at boot, not at first push.
const REQUIRED_BACKEND_METHODS = [
  "write", "read", "remove", "stat", "list", "listReconcilable", "stats", "verify",
  "claim", "restore", "commit", "listClaims", "consumeRead", "isClaimed", "markDelivered",
  "writeTombstone", "hasTombstone", "listTombstones", "removeTombstone",
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
  // Self-describing: verify with the algorithm the entry was WRITTEN with (its
  // stored "<algo>:<hex>"), never a global assumption -- a store may hold entries
  // under different digests (SPEC.md 5). The entry passed integrity on the read
  // path (assertShape -> isValidDigest), so the algorithm always resolves.
  const algo = algoOf(entry.digest);
  const hash = digestHash(algo);
  let resolved = false;
  let delivered = false;
  const verify = new Transform({
    transform(chunk, _encoding, callback) {
      // The first chunk the store emits into the read pipeline is the first byte streamed
      // (SPEC.md 6): `onDeliver` (set only under 'burn') records that observation so crash
      // recovery can tell a claim that streamed a byte from one that never did -- burning
      // the former but RESTORING the latter rather than destroying never-read data. Fired
      // fire-and-forget, NOT awaited: awaiting would make this transform async and shift
      // the stream's backpressure, and the marker is a best-effort crash-recovery hint
      // (the read's own onCommit/onFail is the authoritative resolution), so a marker whose
      // write loses a microsecond race with a crash only softens the burn verdict on that
      // crash -- never a correctness failure of the read itself. A crash before ANY chunk
      // is emitted leaves it unmarked, so the never-streamed case restores precisely.
      if (!delivered) {
        delivered = true;
        if (verdict && verdict.onDeliver) void verdict.onDeliver().catch(() => {}); // drop-silent hint
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    async flush(callback) {
      const got = finalize(hash, algo);
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

// _verifiedInbound(source, entry) -- store()'s write-side digest+size gate. The
// backend recomputes the digest and OVERWRITES stored.digest with it, so an
// unverified store would self-certify whatever bytes arrive (transfer corruption
// recorded as truth -- fail-open, CWE-345). This wraps the replicated source so the
// digest and byte count are checked against the SUPPLIED entry as the bytes stream:
// the throw lands AFTER the last chunk but BEFORE the backend's post-loop
// rename/sidecar, so a mismatch leaves nothing on disk (the failed-push discipline,
// SPEC.md 8). In-stream, never write-then-check -- a post-hoc check would leave the
// corrupt entry live and listed in the window between the write and the check.
async function* _verifiedInbound(source, entry) {
  // Verify against the SUPPLIED entry's own algorithm (its digest is self-
  // describing, validated by assertShape upstream) -- a replicated sha3-512 entry
  // is checked with sha3-512, not a global assumption.
  const algo = algoOf(entry.digest);
  const hash = digestHash(algo);
  let size = 0;
  for await (const chunk of source) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buf);
    size += buf.length;
    yield buf;
  }
  // Size FIRST: a lying `size` with a matching digest would diverge the sidecars
  // across replicas even though the bytes are identical. Both are IntegrityError --
  // untrusted replicated bytes that disagree with their own manifest.
  if (size !== entry.size) throw new IntegrityError();
  if (!constantTimeEqual(finalize(hash, algo), entry.digest)) throw new IntegrityError();
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
 * untouched. Recovery NEVER reclaims a claim a live reader in THIS process is
 * still draining -- single-writer-per-root means the process tracks its own live
 * claims, so the age test (and the wall clock behind it, which a forward step can
 * jump) is consulted only for an ORPHAN with no live holder, i.e. a crashed prior
 * run's. `claimTimeout` therefore bounds how long an orphan sits before recovery
 * resolves it: set it to comfortably exceed the longest `pop`/budgeted read, and
 * keep a disk root to a single writing process. A non-positive `claimTimeout` is
 * refused at construction. `opts.tombstoneTtl` (a duration string, a number of ms, or `null`
 * to never prune; default `'30d'`) is how long a destruction's grave is kept
 * before pruning -- size it above the longest gap between replica reconciliations
 * or a forgotten grave lets an id come back. `opts.digest` picks the integrity
 * hash for new pushes -- `'sha256'` (the default, unchanged), `'sha512'`,
 * `'sha3-256'`, `'sha3-512'`, or `'shake256'`; the stored digest is self-describing,
 * so a read verifies with the entry's OWN algorithm and one store may mix them.
 * Every spec'd option is now accepted and enforced; an unknown one is a
 * config-time TypeError.
 *
 * @example
 *   import { Stash } from "@blamejs/stash";
 *   import { MemoryBackend } from "@blamejs/stash/backends/memory";
 *
 *   const stash = new Stash({ backend: new MemoryBackend(), ttl: "24h" });
 */
// Process-wide live-claim guards, keyed by backend identity (SPEC.md 6 single-writer-per-
// root). Two Stash over the SAME store share ONE guard map, so one instance's crash
// recovery never age-reclaims a claim ANOTHER instance's live reader still holds (which
// would restore/burn a once-only read out from under it). A backend that declares no
// identity keys by the backend OBJECT instead, so two Stash over the same instance still
// coordinate. The entry stays registered for as long as ANY Stash over the store is
// reachable -- NOT dropped by close(), which leaves the store fully usable -- so a store
// re-used after close, or a second instance opened later, still shares the same guard. It
// is released only when the last such Stash is garbage-collected (GUARD_REAP), bounding a
// long-lived process's registry to the stores it can still reach.
const CLAIM_GUARDS = new Map(); // key -> { guard: Map<id, count>, holders: number }
const GUARD_REAP = new FinalizationRegistry((key) => {
  const shared = CLAIM_GUARDS.get(key);
  // Once the LAST holder over a store is collected, the whole entry goes -- INCLUDING any
  // claims still in the map. A Stash dropped without draining/closing a pop leaves its
  // claim guarded, but with its holder gone that claim is stale: keeping it would make a
  // subsequent Stash over the same store treat the abandoned backend claim as live and
  // never reclaim it (stuck ECLAIMED). A concurrent binder that raced this collection has already
  // re-incremented `holders`, so a live guard is not dropped.
  if (shared !== undefined && (shared.holders -= 1) <= 0) CLAIM_GUARDS.delete(key);
});

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
  #tombstoneTtlMs = null;
  // The integrity-hash algorithm for NEW writes (push). Reads are self-describing
  // (they verify with the entry's own stored algorithm), so this only picks what a
  // fresh push records. Default sha256 keeps every existing store byte-identical.
  #digestAlgo = DEFAULT_DIGEST;
  // The lazy crash-recovery scan, memoized: resolved on the first public verb
  // (never in the constructor -- constructors do no I/O), mirroring the disk
  // backend's #init retry-on-failure memo. The memo is re-run once a claim it
  // skipped for being younger than the lease would have aged past it -- #nextRecoverAt
  // is the earliest such deadline (Infinity when the scan resolved everything).
  #recovered = null;
  #nextRecoverAt = 0;
  // Monotone counter bumped by every scan start AND every forced reschedule. A scan
  // publishes its computed next-deadline only if the counter is unchanged since it
  // began; a #scheduleRecover (a faulted resolution) that races an in-flight scan bumps
  // it, so the scan's stale deadline cannot overwrite the forced re-scan.
  #recoverGen = 0;
  // In-flight store() chains, keyed by id: store() serializes concurrent inserts
  // of the SAME id so two replicas cannot both pass the reconcile and race the
  // write (SPEC.md 4.4 write-once). The store is single-writer-per-root, so this
  // in-process gate is the whole concurrency domain; a key is dropped once nothing
  // further is chained behind it, so the map is bounded by live same-id races.
  #storeChains = new Map();
  // The claims currently held over THIS store via a live pop / budgeted-read drain
  // (#claimedRead), by id. #recover consults it to NEVER age-reclaim a claim a live
  // reader holds: recovery's clock/mtime staleness test exists for an ORPHAN (a claim
  // with no live holder), and the wall clock is meaningful only there. The map is SHARED
  // per store (keyed by backend identity in the module CLAIM_GUARDS registry), so two Stash over the same
  // root -- single-writer-per-root (SPEC.md 6) is the contract, but the guard still has
  // to hold when a caller creates two instances -- see one another's live reads and
  // neither age-reclaims the other's mid-drain claim. The id is guarded the instant
  // acquisition BEGINS (before backend.claim writes the on-disk record, so a concurrent
  // #recover crossing a forward clock step in the acquisition window cannot see the fresh
  // claim as an orphan) and dropped the instant the claim resolves (destroy, restore, or
  // burn), so it mirrors exactly the on-disk claims being drained. A crash starts the
  // next process with an EMPTY map, so a genuine prior-run orphan is still reclaimed
  // purely by age -- recovery is not weakened, only kept off a claim a live drain still
  // owns. REFCOUNTED per id: two readers can pass the advisory #rejectIfClaimed before
  // either writes the on-disk claim and both begin acquisition; the one that loses the
  // backend.claim race releases its guard, and a refcount keeps that release from
  // clearing the winner's.
  #liveClaims; // id -> live-holder count; bound LAZILY (#ensureGuardBound) from the shared registry
  #guardIdentity; // the key this instance holds in CLAIM_GUARDS: the backend's identity, or the backend object

  // Bind this instance to the store's shared guard, once, on the first #recover -- when a
  // canonical backend identity is stable (its lazy init has run). The key is the backend's
  // declared identity (the disk root's realpath, a memory instance tag) or, for a backend
  // that declares none, the backend OBJECT (so two Stash over the same instance still
  // coordinate). Registered with GUARD_REAP so the entry is released when this instance is
  // garbage-collected, never on close() (which leaves the store usable).
  #ensureGuardBound() {
    if (this.#liveClaims !== undefined) return;
    const key = this.#backend.identity !== undefined ? this.#backend.identity : this.#backend;
    let shared = CLAIM_GUARDS.get(key);
    if (shared === undefined) {
      shared = { guard: new Map(), holders: 0 };
      CLAIM_GUARDS.set(key, shared);
    }
    shared.holders += 1;
    this.#guardIdentity = key;
    this.#liveClaims = shared.guard;
    GUARD_REAP.register(this, key);
  }
  #guardClaim(ref) { this.#liveClaims.set(ref, (this.#liveClaims.get(ref) ?? 0) + 1); }
  #unguardClaim(ref) {
    const n = (this.#liveClaims.get(ref) ?? 0) - 1;
    if (n > 0) this.#liveClaims.set(ref, n);
    else this.#liveClaims.delete(ref);
  }
  // Force the next public verb to re-run #recover. Called when a claim resolution
  // FAULTS (restore / commit / burn threw): the on-disk claim may still stand as an
  // orphan, and the scan that would reclaim it may not be scheduled -- a scan whose
  // only claims were live leaves #nextRecoverAt at Infinity, and a fault with no
  // concurrent claim never scheduled one at all. Without this, such an orphan is
  // stranded ECLAIMED until restart. A due deadline is harmless when nothing orphaned
  // (the next scan finds no stale claim and reschedules).
  #scheduleRecover() { this.#nextRecoverAt = 0; this.#recoverGen++; }

  constructor(opts) {
    super();
    options(opts, "new Stash", {
      allowed: ["backend", "ttl", "sweepInterval", "maxSize", "maxEntries", "maxTotal", "onPopFailure", "claimTimeout", "tombstoneTtl", "digest"],
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
    // The per-store live-claim guard binds LAZILY, on the first #recover -- never here:
    // a backend's canonical identity (e.g. the disk root's realpath) is only stable after
    // its lazy init has run, and the constructor does no backend I/O. Until then this
    // instance has no claims to guard.
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
    // Strictly POSITIVE: with a zero (or negative) lease staleAt == claimedAt, so
    // recovery would treat EVERY orphan as abandoned the instant it appears --
    // collapsing the orphan grace to nothing. A live in-process reader's own claim is
    // guarded from the start of acquisition regardless (#recover never age-reclaims
    // it), but a non-positive lease is still a broken configuration, refused rather
    // than silently applied. The lease must exceed the longest pop a deployment can
    // run (see the constructor docs).
    if (this.#claimTimeoutMs === null || this.#claimTimeoutMs <= 0) {
      throw new TypeError("new Stash: claimTimeout must be a positive duration");
    }
    // Tombstone lifetime: a grave is pruned once older than this (SPEC.md 4.4),
    // riding the same prune()/sweeper as expiry -- no second timer. An explicit
    // null never prunes (graves live forever); an absent option inherits '30d'.
    const tombstoneTtl = opts.tombstoneTtl === undefined ? DEFAULT_TOMBSTONE_TTL : opts.tombstoneTtl;
    this.#tombstoneTtlMs = parse(tombstoneTtl, "tombstoneTtl");
    // The integrity hash for new writes: a registry algorithm (default sha256).
    this.#digestAlgo = assertDigestAlgo(opts.digest === undefined ? DEFAULT_DIGEST : opts.digest, "new Stash: digest");
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
    // 'sweepError' (NEVER 'error' -- an unhandled 'error' crashes the process; a
    // janitor must not be able to take the app down), through #emitSweepError, which
    // contains a listener's OWN failure -- sync throw OR async rejection -- so it
    // cannot escape either. #emitSweepError returns synchronously, so the chain
    // always fulfils and the guard below always clears (a stuck guard would silently
    // disable the janitor for the process's life) -- no try/finally to misread as a
    // fail-open swallow.
    await work.catch((err) => this.#emitSweepError(err));
    this.#sweepInFlight = null;
  }

  // #emitSweepError(err) -- emit 'sweepError' such that NO listener can crash the
  // janitor. EventEmitter.emit does not await listeners, so an ASYNC listener's
  // rejected promise would escape as an unhandledRejection (fatal on Node -- the
  // outcome the sweep exists to prevent), and a SYNCHRONOUS throw would propagate
  // out of the emit. So each listener runs inside its own promise chain: the one
  // trailing `.catch` contains BOTH failure modes. A handler's own failure is
  // dropped here -- the one sanctioned drop-silent sink (drift rule 8), the reason
  // the failure channel is 'sweepError' and never the fatal 'error'. rawListeners
  // preserves `once` semantics (its wrapper self-removes when called). Emits nothing
  // when there are no listeners.
  #emitSweepError(err) {
    for (const listener of this.rawListeners("sweepError")) {
      Promise.resolve().then(() => listener.call(this, err)).catch(() => {});
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
  // STALE ORPHAN: a claim NOT held by a live in-process reader (#liveClaims) and
  // older than claimTimeout was abandoned by a prior run. A claim a live drain here
  // holds is skipped outright -- never age-reclaimed, since the wall clock a forward
  // step can jump is meaningless for a claim this process knows is live. A younger
  // orphan may be a live pop and is left, then re-checked once it ages. A
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
    const gen = ++this.#recoverGen; // this scan's generation; a forced reschedule during it bumps this
    this.#recovered = (async () => {
      const claims = await this.#backend.listClaims();
      this.#ensureGuardBound(); // listClaims has run the backend's lazy init -> its identity is now stable
      const now = Date.now();
      let nextAt = Infinity;
      for (const { id, claimedAt, delivered } of claims) {
        const staleAt = claimedAt + this.#claimTimeoutMs;
        // A claim a LIVE in-process reader holds is NEVER reclaimed by age: single-
        // writer-per-root (SPEC.md 6) makes this process the sole claimant, so a claim
        // in #liveClaims is a live drain here, not a crashed prior run's orphan. The
        // age/mtime test is for ORPHANS (no live holder) -- and consulting the wall
        // clock for a held claim is exactly what a forward clock step corrupts: a young
        // claim ages past the lease and recovery burns or restores a once-only read
        // mid-drain. But STILL schedule a re-scan for when it would age out: if the drain
        // then drops its guard WITHOUT resolving the on-disk claim (a faulted commit or
        // restore leaving an orphan), that pending scan is what reclaims it -- skipping
        // without rescheduling can end a scan whose only remaining claims are live with
        // #nextRecoverAt = Infinity, stranding such an orphan ECLAIMED until restart. A
        // claim already past its lease (a drain outliving claimTimeout) re-checks one
        // lease out, not on every verb (no hot re-scan loop). Crash recovery is untouched:
        // a prior process's orphans are absent from THIS set and still age-reclaimed below.
        if (this.#liveClaims.has(id)) {
          nextAt = Math.min(nextAt, staleAt > now ? staleAt : now + this.#claimTimeoutMs);
          continue;
        }
        if (now < staleAt) { // still within the lease -- maybe a live pop; leave it,
          nextAt = Math.min(nextAt, staleAt); // but re-scan once it would age past the lease
          continue;
        }
        let hasSidecar = true;
        let corruptSidecar = false;
        try {
          await this.#backend.stat(id);
        } catch (err) {
          if (err instanceof RefNotFound) hasSidecar = false;
          // A corrupt sidecar on a stale orphan claim -- a crash mid consumeRead
          // rewrite leaves the sidecar unparsable while the blob stands in claims/ --
          // is a DAMAGED entry recovery must RESOLVE, never rethrow. Rethrowing poisons
          // the memoized scan, and every verb runs #recover first, so one corrupt
          // claimed entry becomes a permanent store-wide EINTEGRITY denial; verify({
          // repair }) is no escape, since it leaves a CLAIMED corrupt sidecar to recovery
          // (#condemnIfUnclaimed). The entry is unreadable, so restore is meaningless --
          // recovery finishes the destruction (the physical cleanup verify performs for
          // an UNCLAIMED corrupt sidecar), no grave: damage repair is not a lifecycle
          // destruction, so a healthy replica may still reconcile the id back. A
          // STRUCTURAL layout fault also surfaces as IntegrityError, but the commit(id) /
          // isClaimed(id) below re-drive the backend's containment, so genuine fs damage
          // still throws and stays loud (the claim survives, the memo clears for a retry).
          else if (err instanceof IntegrityError) corruptSidecar = true;
          else throw err;
        }
        // A grave already standing for this id means a TERMINAL #destroy (a pop or a
        // spent budget) wrote it and then crashed BEFORE its commit: the destruction
        // was decided, so recovery FINISHES it (commit) and never restores -- a restore
        // would resurrect an entry a grave says is gone (SPEC.md 4.2, 4.4). A
        // sidecar-less claim is the same interrupted commit to finish. A fault reading
        // the grave is a real fault -- it propagates to clear the memo for a retry.
        const graved = await this.#backend.hasTombstone(id);
        // Resolve the stale claim, tolerating one that ANOTHER process's recovery
        // over the same root already resolved between our listClaims and here: two
        // simultaneous starts can list the same stale claim, and the loser's
        // restore then finds it gone (RefNotFound) or its target already restored
        // (IntegrityError). Recovery's contract is only that no stale claim REMAINS,
        // so the verdict is the claim's presence: if it is gone the work is done --
        // swallow the fault; a claim still standing after a failed restore/commit is
        // a real fault, propagated to clear the memo for a retry.
        try {
          if (graved || !hasSidecar || corruptSidecar) {
            await this.#backend.commit(id); // finish a decided/interrupted destruction, or reap an unreadable one
          } else if (this.#onPopFailure === "burn" && delivered) {
            // Burn ONLY a claim that delivered a byte to a consumer (`delivered`): burn's
            // rationale is "a read attempt means the bytes may have been observed", and a
            // claim that crashed before streaming a byte observed nothing -- burning it
            // would silently destroy never-read data (SPEC.md 6). A delivered claim burned
            // by policy is a FRESH destruction, so it must leave a grave (SPEC.md 4.4) or a
            // replica could store() the id back, resurrecting content the burn removed.
            // Grave BEFORE commit (the #destroy ordering). Recovery reconciles a PRIOR
            // process's residue -- an entry this process's listeners never observed -- so it
            // writes the durable grave but emits no event (unlike the live burn). The claim
            // cannot say whether it was a pop or a budgeted read, so the grave records the
            // generic read cause.
            await this.#backend.writeTombstone(id, makeTombstone(id, "pop"));
            await this.#backend.commit(id);
          } else {
            // 'restore' policy, OR a 'burn' claim that never delivered a byte: return the
            // entry. A never-delivered burn orphan is unobserved, so restoring it (rather
            // than destroying it) is correct -- the entry survives for a retry, no grave.
            await this.#backend.restore(id);
          }
        } catch (err) {
          if (await this.#backend.isClaimed(id)) throw err;
        }
      }
      // Publish this scan's deadline ONLY if no forced reschedule raced it: a
      // #scheduleRecover during the scan bumped the generation and set the deadline due,
      // for an orphan this scan (which listed claims before it existed) could not have
      // seen -- its stale nextAt must not overwrite that forced re-scan.
      if (gen === this.#recoverGen) this.#nextRecoverAt = nextAt;
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
  async #claimedRead(ref, onCommit, destruction) {
    // Guard BEFORE acquisition, not after: backend.claim writes the on-disk claim
    // during its own awaits, so a concurrent #recover racing this drain would see a
    // fresh claim with no live holder and -- a forward wall-clock step aging it past
    // claimTimeout -- restore or burn it out from under the reader, handing the same
    // once-only bytes to a second reader. Recording the guard first closes that
    // acquisition window; if the claim FAILS (RefClaimed to a loser, RefNotFound),
    // this drain never became the holder, so the guard is released.
    this.#guardClaim(ref);
    let entry, source;
    try {
      ({ entry, source } = await this.#backend.claim(ref));
    } catch (err) {
      this.#unguardClaim(ref);
      throw err;
    }
    if (isExpired(entry, Date.now())) {
      _dispose(source);
      try {
        await this.#backend.restore(ref);
        if (await this.#backend.remove(ref)) this.#emit("expired", entry); // lazy-drop, witnessed; expiry writes NO grave
      } catch (err) {
        this.#scheduleRecover(); // a faulted restore leaves the claim an orphan -- ensure a re-scan reclaims it
        throw err;
      } finally {
        // Drop the guard whether the restore/remove resolved OR faulted: a faulted
        // restore leaves the claim standing as an ORPHAN, and #recover can only
        // reclaim it if this process is no longer flagged as its live holder --
        // leaving the guard set would pin the orphan forever (the same `finally`
        // discipline the onCommit/onFail verdicts use).
        this.#unguardClaim(ref);
      }
      throw new RefNotFound();
    }
    return _verifiedStream(entry, source, {
      // Under 'burn' ONLY, record that the first byte reached the consumer, so a crash
      // recovery can tell a delivered claim (observed -> burn) from a never-delivered one
      // (unobserved -> restore, never destroy never-read data; SPEC.md 6). The default
      // 'restore' policy always restores an orphan, so it needs no marker and pays no
      // per-read cost. The marker rides the claim and is cleared on restore/commit.
      onDeliver: this.#onPopFailure === "burn" ? () => this.#backend.markDelivered(ref) : undefined,
      // Drop the live-holder guard once the verdict RESOLVES the claim (a destroy, a
      // debit+restore, or a burn), never before, and in a `finally` so a resolution
      // fault still releases it: the read is over, and a claim a faulted commit left
      // standing is exactly the still-standing orphan #recover resolves later (the
      // _verifiedStream contract). The verdict fires exactly once (the `resolved`
      // latch), so exactly one branch runs and drops the id.
      onCommit: async () => {
        try { await onCommit(entry); }
        catch (err) { this.#scheduleRecover(); throw err; } // a faulted commit leaves an interrupted destruction orphan
        finally { this.#unguardClaim(ref); }
      },
      // 'burn' destroys the entry the read could not consume: it runs the SAME
      // grave-then-commit-then-emit terminal a successful drain runs (a burned
      // entry leaves a grave, SPEC.md 4.4, and is never destroyed silently,
      // SPEC.md 4.3). 'restore' returns the entry, which survives, so it writes no
      // grave and emits nothing.
      onFail: async () => {
        try {
          await (this.#onPopFailure === "burn"
            ? this.#destroy(ref, entry, destruction.cause, destruction.event)
            : this.#backend.restore(ref));
        } catch (err) { this.#scheduleRecover(); throw err; } // a faulted burn/restore leaves the claim an orphan
        finally { this.#unguardClaim(ref); }
      },
    });
  }

  // #destroy(ref, entry, cause, event) -- the shared terminal destruction of a
  // claimed read (pop, a budget-exhausting apply, or either one burned): write the
  // grave FIRST (SPEC.md 4.4), then commit the deletion, then emit. Grave-before-
  // commit is the crash-safe order -- a crash between them leaves a tombstoned-but-
  // present entry, which store() already refuses; the reverse order would resurrect
  // (CWE-459). pop and a spent budget differ only in cause/event.
  async #destroy(ref, entry, cause, event) {
    await this.#backend.writeTombstone(ref, makeTombstone(ref, cause));
    await this.#backend.commit(ref);
    this.#emit(event, entry);
  }

  /**
   * @primitive  stash.push
   * @signature  stash.push(source, opts) -> Promise<string>
   * @since      0.1.0
   * @status     experimental
   * @spec       SPEC.md 4, SPEC.md 5, FIPS 180-4, FIPS 202, RFC 4648, RFC 8259
   * @defends    CWE-330
   * @related    stash.apply, stash.show, stash.drop
   *
   * Store bytes; resolve to the entry's ref. The source may be a Buffer, a
   * Uint8Array, a UTF-8 string, a Readable, or any AsyncIterable of chunks;
   * it streams through to the backend, which computes size and the
   * digest as the bytes pass -- with the algorithm chosen at construction
   * (`sha256` by default). `opts.meta` is a caller-owned plain object,
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
      // Two passes, and by design they do not collapse into one. prune() opens and
      // parses every sidecar to reap the dead -- it MUST run first, because maxTotal
      // charges its mid-stream residual against the LIVE footprint: total stats.bytes
      // that still counted an expired entry would tighten the residual and reject a
      // push that fits once the dead one is reaped (a dead entry blocking a live
      // push). stats() then totals the PHYSICAL footprint -- blob + sidecar file
      // sizes PLUS orphan blobs and sidecar-less claim blobs that list() never sees,
      // the maxTotal-bypass accounting only a layout walk can do. So the reap scan
      // cannot surface the footprint (deriving it from prune()'s entry list would
      // under-count those orphans and weaken maxTotal), and the footprint walk cannot
      // subsume the reap (folding expiry into the backend's walk pushes a policy
      // decision into a backend that must not interpret it, SPEC.md 9). The full scan
      // is by-design cheap at maxEntries scale (SPEC.md 3); a central count/index to
      // make the gate O(1) is exactly the mutable-file coupling the sidecar design
      // rejects.
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
    // Self-describing selection: stamp the entry with the chosen algorithm's pending
    // marker ("<algo>:") so it travels INSIDE the documented write(id, source, entry)
    // contract -- the backend reads it back (algoOf) and computes that hash. Threading
    // the algorithm as an out-of-band write() argument would let a custom backend built
    // to the 3-arg contract silently drop the selection back to the default.
    entry.digest = digestMarker(this.#digestAlgo);
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
   * @spec       SPEC.md 4, FIPS 180-4, FIPS 202
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
          await this.#destroy(ref, claimed, "spent", "dropped"); // the last credit: grave + commit + 'dropped'
        } else {
          await this.#backend.consumeRead(ref); // persist the debit BEFORE restoring (fragile area 5)
          await this.#backend.restore(ref); // a non-terminal read destroys nothing -- no grave, no event
        }
      }, { cause: "spent", event: "dropped" }); // a burned budgeted read destroys the entry -> 'dropped'
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
   * @spec       SPEC.md 4, SPEC.md 6, FIPS 180-4, FIPS 202
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
    return this.#claimedRead(ref,
      (entry) => this.#destroy(ref, entry, "pop", "popped"), // grave + commit + 'popped'
      { cause: "pop", event: "popped" }); // a burned pop's delete also lands -> a 'pop' grave, 'popped'
  }

  /**
   * @primitive  stash.store
   * @signature  stash.store(entry, source) -> Promise<boolean>
   * @since      0.1.9
   * @status     experimental
   * @spec       SPEC.md 4, SPEC.md 4.4, FIPS 180-4, FIPS 202, RFC 8259
   * @defends    CWE-345, CWE-354, CWE-20
   * @related    stash.push, stash.tombstones, stash.drop
   *
   * The replication-grade insert (SPEC.md 4.4): file an already-created entry,
   * preserving its identity where `push` mints a new one. The caller supplies the
   * COMPLETE `Entry` -- `id`, `createdAt`, `expiresAt`, `reads`, `readsLeft`,
   * `digest`, `meta` -- and it lands verbatim; the bytes are verified against the
   * supplied `digest` and `size` as they stream, so transfer corruption is caught
   * on the way in and nothing lands. It proceeds in a normative order:
   *
   *   1. a malformed id is `InvalidRef`, before any storage access;
   *   2. a tombstoned id returns `false`, writing nothing -- a destroyed id never
   *      comes back;
   *   3. an entry already past its `expiresAt` is a no-op `false` (the dead travel
   *      as dead, and get no grave);
   *   4. an identical live entry (same id, same digest) is an idempotent no-op
   *      `false`, so a retry-based sync is free;
   *   5. same id, different digest is an `IntegrityError` -- corruption, not a
   *      merge; the existing entry is untouched;
   *   6. otherwise it writes exactly like `push`, every field the caller's, and
   *      returns `true`.
   *
   * A genuinely new entry (past step 5) is charged against the stash bounds exactly
   * as a `push` is: a replica larger than `maxSize` aborts `SizeExceeded`, and one
   * past `maxEntries` / `maxTotal` is refused `StashFull` -- replication input does
   * not get to slip the configured capacity. Concurrent stores of the SAME id are
   * serialized so two conflicting replicas cannot both land (the loser sees the
   * winner and reconciles: idempotent-`false` or an `IntegrityError`).
   *
   * `store` emits NO event: a sync daemon that heard its own writes would echo them
   * back forever, so the silence removes that bug class here rather than in every
   * caller. The replicated entry is untrusted input -- a shape violation, a digest
   * that is not a well-formed `<algo>:<hex>` for a registry algorithm, an incoherent
   * read budget, or a non-plain `meta` is an `IntegrityError`, never a partial write.
   *
   * A read budget is enforced per store, so two replicas of a `reads: 1` entry can
   * each serve one full read before their tombstones converge -- exactly-once
   * becomes eventually-once. Serve reads from a single node (cold standby) unless
   * that weaker guarantee is a deliberate choice.
   *
   * @example
   *   for (const e of await primary.list()) await replica.store(e, bytesFor(e.id));
   */
  async store(rawEntry, source) {
    // The replicated entry and its bytes are BOTH untrusted. The argument being a
    // plain object and the source being an accepted type are config-time
    // TypeErrors; every verdict on the entry's CONTENT past that is a typed
    // IntegrityError -- replicated bytes are stored input, not a caller argument.
    plainObject(rawEntry, "store: entry");
    // Step 1: a malformed id dies at the whitelist BEFORE any backend access -- the
    // ref-validation-precedes-storage invariant every verb holds (hard rule 4). This
    // MUST precede the store chain / #recover(), which touch the backend.
    assertValid(rawEntry.id);
    const chunks = _toChunkSource(source);
    const ref = rawEntry.id;
    // Serialize concurrent store()s of the SAME id: two sync workers filing
    // conflicting replicas of one id must not both pass the reconcile and race the
    // write -- memory would last-writer-win and disk would raw-EEXIST on the shared
    // blob tmp, neither honoring write-once / the digest-conflict verdict (SPEC.md
    // 4.4). Chain onto any in-flight store for this id so the loser runs AFTER the
    // winner lands and reconciles against it (idempotent-false, or an IntegrityError
    // on a different digest). The store is single-writer-per-root, so this in-process
    // gate spans the whole supported concurrency domain.
    const prior = this.#storeChains.get(ref);
    const mine = (async () => {
      if (prior) await prior; // await my turn; prior is the never-rejecting chain tail
      return this.#storeOne(rawEntry, chunks, ref);
    })();
    const tail = mine.catch(() => {}); // the tail never rejects, so a failed store still releases the next in line
    this.#storeChains.set(ref, tail);
    try {
      return await mine;
    } finally {
      if (this.#storeChains.get(ref) === tail) this.#storeChains.delete(ref); // last in line -- bound the map
    }
  }

  // #storeOne(rawEntry, chunks, ref) -- store()'s serialized body: the SPEC.md 4.4
  // reconcile order (tombstoned -> expired -> identical -> digest-conflict), then the
  // same capacity gate push() applies (a replicated entry is untrusted -- it must
  // honor maxSize/maxEntries/maxTotal), then the verified, bounded write.
  async #storeOne(rawEntry, chunks, ref) {
    await this.#recover();
    // Normalize meta to its STORED form BEFORE validating: the backend persists the entry
    // via JSON.stringify, so a meta that is not a plain JSON object -- a Date, or a plain
    // object whose toJSON() returns a scalar -- would serialize to a scalar and then be
    // rejected by every later show()/list() read: a store() that "succeeds" into an
    // unreadable entry. Validate the round-tripped value (what actually lands), exactly as
    // push does; a meta that does not survive the round-trip as a plain object is an
    // IntegrityError (untrusted replicated input), never a bad write.
    const metaJson = JSON.stringify(rawEntry.meta);
    const entry = { ...rawEntry, meta: metaJson === undefined ? undefined : JSON.parse(metaJson) };
    // Full shape of the replicated entry (id re-checked plus every other field, meta in
    // its stored form).
    assertShape(entry, IntegrityError);

    // Step 2: a tombstoned id never comes back.
    if (await this.#backend.hasTombstone(ref)) return false;
    // Step 3: an entry already past its deadline is dead on arrival -- no-op, no grave.
    if (isExpired(entry, Date.now())) return false;
    // Steps 4/5: reconcile against an existing entry. The stat probe swallows ONLY
    // RefNotFound (absent); corruption or an fs fault propagates, never a false.
    let existing = null;
    try {
      existing = await this.#backend.stat(ref);
    } catch (err) {
      if (!(err instanceof RefNotFound)) throw err;
    }
    // Steps 4/5 reconcile on BYTE IDENTITY (SPEC.md 4.4: step 4 no-ops "same bytes",
    // step 5 conflicts on "different bytes"), NOT on the algo-tagged digest STRING. When
    // both entries share an algorithm the strings are directly comparable; when they
    // differ -- a mixed-algorithm store, first-class per SPEC.md 5 -- identical bytes
    // carry different digest strings, so the strings can't decide it.
    if (existing !== null) return this.#reconcileExisting(existing, entry, chunks);

    // Capacity gate: a genuinely new entry (existing === null) is charged against the
    // stash bounds exactly as a push is -- otherwise a replica larger than maxSize, or
    // any replica past maxEntries/maxTotal, slips the configured safeguards (replication
    // input is untrusted). Expired entries are reaped first so a dead-but-unswept entry
    // never rejects a live replica (the push discipline) -- and the prune-then-stats two
    // passes are irreducible for the reason push() documents (the reap must precede the
    // footprint total, and neither scan subsumes the other). Across DIFFERENT ids the
    // stats read and the write are not atomic (concurrent inserts overshoot by the
    // in-flight count, as push documents); the per-id chain makes the SAME id exact.
    let residual = null;
    if (this.#maxEntries !== null || this.#maxTotal !== null) {
      await this.prune();
      const stats = await this.#backend.stats();
      if (this.#maxEntries !== null && stats.entries >= this.#maxEntries) throw new StashFull();
      if (this.#maxTotal !== null) {
        // The replicated sidecar is the entry in its stored form (write re-derives the
        // same size/digest the stream verifies), so its serialized footprint is exact.
        const sidecarBytes = Buffer.byteLength(JSON.stringify(entry));
        residual = this.#maxTotal - stats.bytes - sidecarBytes;
        if (residual < 0) throw new StashFull();
      }
    }

    // Step 6: write like push, but every field is the caller's. The bytes are bounded
    // by maxSize and the maxTotal residual mid-stream (_boundedSource) AND verified
    // in-stream against the supplied digest AND size (_verifiedInbound -- the backend
    // would otherwise self-certify whatever arrives). An over-bound abort or a mismatch
    // throws before the backend's rename, leaving nothing on disk (SPEC.md 8). store is
    // silent -- no event on this write.
    const bounded = _verifiedInbound(_boundedSource(chunks, this.#maxSize, residual), entry);
    // The replicated entry already carries its full self-describing digest, so the
    // backend re-hashes with the entry's own algorithm (algoOf) and a sha3-512 entry
    // lands as sha3-512 -- the selection rides in the entry, never an extra argument.
    await this.#backend.write(ref, bounded, entry);
    // TOCTOU (fragile area, CWE-367): a concurrent pop/drop could dig the grave
    // between the step-2 check and this write landing. The grave must ALWAYS win --
    // a store onto a tombstoned id would resurrect it -- so re-check AFTER the
    // write; if a grave appeared, remove what was just stored and refuse.
    if (await this.#backend.hasTombstone(ref)) {
      await this.#backend.remove(ref);
      return false;
    }
    return true;
  }

  // #reconcileExisting(existing, entry, chunks) -- store()'s SPEC.md 4.4 step-4/step-5
  // verdict against an entry already holding this id, keyed on BYTE IDENTITY: step 4
  // no-ops "same bytes" (idempotent false), step 5 conflicts on "different bytes"
  // (IntegrityError -- corruption, not a merge). BOTH outcomes write NOTHING and leave
  // the existing entry -- and its algorithm -- untouched, so the reconcile never
  // resurrects and never accepts mismatched bytes.
  async #reconcileExisting(existing, entry, chunks) {
    const existingAlgo = algoOf(existing.digest);
    if (existingAlgo === algoOf(entry.digest)) {
      // Same algorithm: the hex is directly comparable, so a constant-time string compare
      // settles identity without touching the bytes -- the common path (an id carries one
      // algorithm through ordinary replication). Same string -> step 4; different -> step 5.
      if (constantTimeEqual(existing.digest, entry.digest)) return false;
      throw new IntegrityError();
    }
    // Different algorithm (a mixed-algorithm store, SPEC.md 5): the digest STRINGS are
    // incomparable, so re-hash the incoming source under the existing algorithm to decide
    // on the bytes. _verifiedInbound verifies the stream against the incoming entry's OWN
    // digest and size -- an untrusted replica that lies about its manifest is IntegrityError
    // here, exactly as on the write path -- and the existing-algorithm hash then proves byte
    // identity against the stored content. existingAlgo always resolves: stat() returns a
    // shape-validated entry (its digest is self-describing), the same invariant
    // _verifiedStream/_verifiedInbound rely on.
    //
    // A same-bytes duplicate must no-op even when the current maxSize sits BELOW the stored
    // entry -- maxSize was lowered since it was stored, or this replica carries a tighter
    // limit than the one that accepted it. The same-algorithm path above no-ops on the
    // digest string without re-reading, so this cross-algorithm path must not reject on a
    // WRITE-path limit it never writes under (a reconcile writes nothing, charges no maxTotal
    // residual). A declared size that already differs is a conflict with no re-read; otherwise
    // bound the re-hash by the EXISTING entry's own (trusted, already-stored) size -- a stream
    // longer than the stored bytes cannot be identical, so it bounds a hostile replica exactly
    // without consulting maxSize.
    if (entry.size !== existing.size) throw new IntegrityError();
    const hash = digestHash(existingAlgo);
    let seen = 0;
    for await (const buf of _verifiedInbound(chunks, entry)) {
      seen += buf.length;
      // A stream longer than the stored bytes cannot be identical: bound the drain to the
      // existing size (so a hostile replica cannot stream unboundedly) and treat any
      // overflow as a byte CONFLICT -- IntegrityError, never SizeExceeded. A reconcile
      // enforces no write limit, so an oversized cross-digest replica under this id is
      // different bytes (step 5), not a maxSize violation.
      if (seen > existing.size) throw new IntegrityError();
      hash.update(buf);
    }
    // Self-consistent incoming bytes (verified above) that reproduce the stored entry's
    // digest under its OWN algorithm ARE the stored content -> step 4 idempotent no-op.
    // Anything else is genuinely different bytes under the same id -> step 5.
    if (constantTimeEqual(finalize(hash, existingAlgo), existing.digest)) {
      return false;
    }
    throw new IntegrityError();
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
   * @primitive  stash.tombstones
   * @signature  stash.tombstones() -> Promise<Tombstone[]>
   * @since      0.1.9
   * @status     experimental
   * @spec       SPEC.md 4, SPEC.md 4.4
   * @related    stash.store, stash.drop
   *
   * The graves, for reconciliation: `{ id, destroyedAt, cause }[]` -- an id that
   * was destroyed, when (ms since the epoch), and how (`'pop'` / `'drop'` /
   * `'clear'` / `'spent'`), and NOTHING that describes the body (no digest, size,
   * or meta -- recording those would leak the content the destruction removed).
   * Expiry leaves no grave (terms travel with the entry). A query: it inspects the
   * shelf, never moves bytes, and is loud over a corrupt grave, the same as
   * `list()`. Feed each id to a replica's `drop()` to converge the two stores.
   *
   * @example
   *   for (const grave of await primary.tombstones()) await replica.drop(grave.id);
   */
  async tombstones() {
    await this.#recover();
    return this.#backend.listTombstones();
  }

  /**
   * @primitive  stash.verify
   * @signature  stash.verify(opts?) -> Promise<Report>
   * @since      0.1.8
   * @status     experimental
   * @spec       SPEC.md 4, FIPS 180-4, FIPS 202
   * @related    stash.stats, stash.prune
   *
   * Audit the store's physical integrity. Dry-run by default: it digest-checks
   * every blob (streamed, never a full-blob read) and reports damage --
   * `digest-mismatch`, `size-mismatch`, `corrupt-sidecar`, `missing-blob`,
   * `orphan-blob`, `orphan-tmp`, `foreign-file`, `stale-claim`, `corrupt-tombstone`,
   * `orphan-delivered` (a delivery marker whose claim is gone -- inert, since ids never
   * repeat, but layout residue repair reaps) -- without touching anything. `{ repair: true }` removes ONLY what it condemns (a
   * damaged entry's blob and sidecar together, or a corrupt grave whose contents fail
   * the parser); healthy entries survive byte-identical, a fresh push's in-flight
   * `.tmp` is spared, and a stale claim is reported but never deleted (resolving it is
   * crash recovery's job -- deleting a restorable claim would be data loss). The Report
   * is `{ scanned, findings: [{ kind, id }], repaired: [{ kind, id }] }`; `id` is the
   * ref for ref-shaped damage (the store is the embedder's) and `null` for a foreign
   * name -- verify never echoes an on-disk path. Damage is a FINDING; an I/O fault (a
   * permission denial, a vanished layout dir) THROWS -- a walk error absorbed into a
   * clean report would be fail-open. A condemnation is physical cleanup of already-
   * broken data, not a lifecycle destruction, so it writes no grave (the SPEC.md 4.4
   * causes are pop/drop/clear/spent); a corrupt grave is simply removed.
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
    // verify does NOT run #recover: it AUDITS the store as-is and REPORTS stale
    // claims (SPEC.md 6 -- resolving one is recovery's job, run by every mutating
    // verb and at construction, never by an audit). Recovering here would make a
    // dry run MUTATE (a restore/burn) and would hide the very stale-claim finding
    // verify exists to surface -- a fresh auditor process whose first call is
    // verify() must see the crash residue, not silently clean it. claimTimeout is
    // policy (M5), passed down so the backend can age a stale claim without owning
    // the threshold; the tmp grace is C.AUDIT.
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
   * @primitive  stash.reconcilable
   * @signature  stash.reconcilable() -> Promise<{ entries: Entry[], corrupt: string[] }>
   * @since      0.1.15
   * @status     experimental
   * @spec       SPEC.md 4, SPEC.md 4.4
   * @related    stash.list, stash.tombstones, stash.store, stash.verify
   *
   * The reconciliation-grade listing for anti-entropy (SPEC.md 4.4). `list()` is
   * loud over a corrupt sidecar -- it fails the whole listing so damage is never
   * silently dropped -- which is right for an audit but wrong for a sync loop: a
   * single unreadable entry would abort enumeration and stall replication of every
   * healthy one. `reconcilable()` returns `{ entries, corrupt }` instead. `entries`
   * is the healthy metadata a full-scan pass replicates (expired entries filtered,
   * exactly as `list()`), and `corrupt` is the ref ids whose sidecars are too damaged
   * to read. One rotten sidecar no longer blocks the sync of sound entries, and the
   * damage is SURFACED, never swallowed -- route `corrupt` to `verify({ repair: true })`
   * to reap it. Structural layout damage (a foreign file in the store) and I/O faults
   * still throw, as in `list()`: neither is a per-entry corruption with a ref to
   * report. Contents never appear; a listing that leaked blob bytes would defeat the
   * point of refs as capabilities.
   *
   * @example
   *   const { entries, corrupt } = await from.reconcilable();
   *   for (const entry of entries) await to.store(entry, bytesFor(entry.id));
   *   if (corrupt.length) console.warn("corrupt sidecars, run verify({ repair: true }):", corrupt.length);
   */
  async reconcilable() {
    await this.#recover();
    const { entries, corrupt } = await this.#backend.listReconcilable();
    const now = Date.now();
    // Filter expired entries exactly as list() does: an expired entry is
    // nonexistent on every read surface (SPEC.md 7), and every replica reaches the
    // same deadline on its own clock, so store() no-ops one anyway -- shipping it is
    // wasted transport. `corrupt` passes through untouched: a damaged sidecar's terms
    // are unreadable, so it cannot be judged expired and is surfaced regardless.
    return { entries: entries.filter((entry) => !isExpired(entry, now)), corrupt };
  }

  /**
   * @primitive  stash.drop
   * @signature  stash.drop(ref) -> Promise<boolean>
   * @since      0.1.0
   * @status     experimental
   * @spec       SPEC.md 4
   * @related    stash.clear, stash.list
   *
   * Delete an entry without reading it, and tombstone the id. Resolves `false`
   * when the ref names nothing LIVE -- an absent entry is a fact, not a failure --
   * and `true` when a live entry was destroyed. A malformed ref still throws
   * `InvalidRef`; replication input and typos both die at the whitelist. A corrupt
   * entry is still removed -- drop deletes without reading, so a sidecar too
   * damaged to parse never blocks cleanup; it carries no lifecycle event (there is
   * no whole Entry to hand a listener). `verify` is the audit path that classifies
   * the damage. Dropping an id the store never held still leaves a grave: that is
   * how a tombstone propagates across replicas (SPEC.md 4.4) -- reconciliation
   * `drop`s each of the other node's grave ids, so a destroyed id is refused even
   * on a node that never held it. Expiry is the one exception that leaves no grave
   * (its terms travel with the entry, and every replica reaches the same deadline).
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
      if (err instanceof RefNotFound) {
        // The ref names no live entry here, but drop STILL writes a grave: this is how a
        // tombstone PROPAGATES across replicas (SPEC.md 4.4 -- reconciliation drop()s each
        // of the other node's grave ids). A node that never held the id must adopt the
        // grave, or a later sync from a stale node resurrects the entry the destruction
        // removed -- the resurrection an empty or intermediate replica would otherwise
        // permit. Grave BEFORE the remove (the #destroy ordering); remove() also cleans an
        // orphaned blob a crash mid-remove (sidecar first, then blob) may have stranded.
        // Returns false -- no LIVE entry was destroyed -- but the id is now tombstoned.
        await this.#backend.writeTombstone(ref, makeTombstone(ref, "drop"));
        await this.#backend.remove(ref);
        return false;
      }
      // A sidecar too corrupt to parse must not make the entry un-droppable: drop
      // deletes without reading (unlike show/has, which surface the corruption). A
      // corrupt entry existed and is destroyed, so it leaves a grave (its bytes are
      // unreadable but its id is known); there is no whole Entry to carry, so no
      // event fires -- verify({ repair: true }) is the richer audit path.
      if (err instanceof IntegrityError) {
        await this.#backend.writeTombstone(ref, makeTombstone(ref, "drop"));
        return this.#backend.remove(ref);
      }
      throw err;
    }
    const expired = isExpired(entry, Date.now());
    // A live drop leaves a grave (SPEC.md 4.4), written BEFORE the remove; an
    // expired entry is already dead -- its terms travel with it, so expiry writes
    // no grave. A grave already standing (a concurrent pop won the race) is kept
    // (first-write-wins), so its cause is not clobbered.
    if (!expired) await this.#backend.writeTombstone(ref, makeTombstone(ref, "drop"));
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
      // A grave per LIVE entry destroyed (cause 'clear'), written before its remove;
      // an expired entry writes none (expiry travels with the entry). clear does not
      // remove existing tombstones -- destruction is monotone across replicas.
      if (!expired) await this.#backend.writeTombstone(entry.id, makeTombstone(entry.id, "clear"));
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
    // Prune stale graves (SPEC.md 4.4): a tombstone older than tombstoneTtl is
    // reaped, riding THIS sweep -- no second timer (fragile area: one janitor). A
    // null tombstoneTtl never prunes. listTombstones is loud over a corrupt grave,
    // the same prune-is-loud-over-corruption discipline the entry scan holds.
    if (this.#tombstoneTtlMs !== null) {
      for (const grave of await this.#backend.listTombstones()) {
        if (now - grave.destroyedAt >= this.#tombstoneTtlMs) await this.#backend.removeTombstone(grave.id);
      }
    }
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
    // close() does NOT release the per-store shared guard: it stops only the janitor and
    // leaves the store fully usable (a closed store still serves push/apply/pop), so a
    // claim taken after close, or a second Stash opened later over the same store, must
    // still find the guard registered. The entry is released when this instance is garbage-
    // collected (GUARD_REAP), never here.
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
