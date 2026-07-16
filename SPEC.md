# StashJS — Specification

StashJS is a zero-dependency, ephemeral, crypto-agnostic content store for Node.js. You hand
it bytes and get back a ref, and you can read those bytes back once before they're deleted.

It stores data at rest and nothing more. The calling application hands it opaque bytes;
StashJS never inspects the contents. Anything that needs to understand the data — encryption,
indexing, parsing — is the caller's job.

---

## 1. The one rule

StashJS can't decrypt anything, because it has nowhere to put a key. No method takes a key,
nothing in the source imports a cipher, and there is no `decrypt`, `secret`, or `passphrase`
option.

This is deliberate, and it's the main reason the library exists. If the code has no way to
decrypt, an operator who is pressured to produce plaintext has nothing to produce: no key is
stored anywhere, and there is no decryption path to run. That only works if the capability is
genuinely missing, so it has to be absent by construction rather than turned off by a flag.
Encryption is the caller's responsibility — it's the layer that has a threat model.

`node:crypto` is allowed for hashing and random IDs only: `createHash`, `randomBytes`, and
`timingSafeEqual`. Never `createCipheriv` or `createDecipheriv`.

If a feature seems to require StashJS to understand what's inside a blob, it belongs somewhere
else. Stop and ask.

---

## 2. Runtime and non-negotiable constraints

- **Node 24.18.0.** `"engines": { "node": ">=24.18.0" }`, with a `.node-version` / `.nvmrc` of
  `24.18.0`. Treat this as a floor to build against: no polyfills, no compatibility shims, no
  `if (nodeVersion < x)` branches for older runtimes.
- **Zero dependencies**, runtime and dev. Node builtins only; tests use `node:test` and
  `node:assert`. If something can't be done without adding a package, stop and ask.
- **ESM only.** `"type": "module"`, plain JavaScript. No TypeScript, no build step, no
  bundler. If type definitions are ever needed they ship as hand-written `.d.ts`, but not now.
- **Streaming-first.** No method buffers an entire blob in memory. Size limits are checked as
  the bytes pass, not by loading the whole blob to measure it.

### 2.1 Permission model posture

The Node permission model went stable in 23.5, so on 24.18.0 the flag is `--permission`, not
`--experimental-permission`. StashJS should run cleanly under:

```
node --permission --allow-fs-read=./.stash/* --allow-fs-write=./.stash/* app.js
```

This is §1 again, enforced by the runtime instead of by discipline: the process that holds the
blobs is confined to the directory that holds them. A compromised dependency elsewhere in the
application can't read the stash, and StashJS can't read anything outside its root.

Design implications, all mandatory:

- **No child processes, no worker threads, no native addons, no WASI.** Each needs its own
  `--allow-*` grant and widens the sandbox, and StashJS needs none of them.
- **Symlinks are followed even outside granted paths.** This is a documented limitation of the
  permission model, so the DiskBackend has to do its own containment check (§9); the sandbox
  won't do it.
- **Existing file descriptors bypass the model.** Never accept an fd as input — paths only.
- Don't call `process.permission.has()` to branch behavior. If a grant is wrong, let the
  `ERR_ACCESS_DENIED` surface rather than degrading quietly.
- `--permission` in 24.x does **not** gate the network. Don't claim in the README that it does.
  StashJS opens no sockets in any case, which is the guarantee it can actually make.

Ship the flags in `examples/` and the README. It's a large security win for almost no effort,
and most callers won't know the option exists.

---

## 3. Do not build these

Each of these will look like a helpful addition and is a mistake.

- **No encryption.** See §1.
- **No content addressing or dedup.** Refs are random, not content hashes. §5 explains why;
  read it before changing this.
- **No compression.** The payload is ciphertext, which won't compress, and compressing before
  encryption is a CRIME/BREACH-class leak. It isn't StashJS's layer regardless.
- **No `node:sqlite` index.** Tempting because it's a builtin, so it technically satisfies §2's
  zero-dependency rule. Reject it anyway: it's still experimental on 24.x, sidecar files are
  already crash-safe (§9), and the permission model does not gate filesystem access made
  through `node:sqlite`, so adopting it would open a hole in §2.1.
- **No mimetype sniffing, content inspection, thumbnailing, or virus scanning.** The bytes are
  opaque.
- **No HTTP server, routes, or multipart parsing.** That belongs to the caller.
- **No cloud backends.** Disk and memory only in v1.
- **No eviction.** A cache can evict to make room because its entries are disposable hints; a
  stash entry is a commitment the caller was handed. A store that silently dropped the oldest
  entry when full would turn a flood of pushes into a way to delete other people's data. When
  full, `push` fails with `StashFull` and destroys nothing.
- **No `touch()`, TTL extension, or metadata mutation.** See the monotone rule (§4.2).
- **No namespaces.** Logical partitions inside one store add key-prefix machinery for something
  two `Stash` instances with two roots already do without it.
- **No sync transport or oplog.** Replication support is limited to §4.4's tombstones and
  `store()`; the wire format, schedule, and topology belong to the caller. No change journal
  either — full-scan anti-entropy over `list()` + `tombstones()` is cheap at `maxEntries`
  scale, and a journal is the kind of central mutable file the sidecar design (§9) avoids.
- **No logging of refs or metadata values.** A ref is a capability, so a ref in a log is a
  leaked capability. Log counts and error codes, never identifiers or `meta` contents.
- **No telemetry, analytics, or phoning home.**

---

## 4. Public API

```js
import { Stash } from '@blamejs/stash';
import { DiskBackend } from '@blamejs/stash/backends/disk';

const stash = new Stash({
  backend: new DiskBackend({ root: './.stash' }),
  ttl: '24h',
  maxSize: '100mb',
  maxEntries: 10_000,
  onPopFailure: 'restore',
  tombstoneTtl: '30d',
  sweepInterval: '5m',
});
```

### Methods

| Method | Returns | Notes |
|---|---|---|
| `push(source, opts?)` | `Promise<string>` (ref) | `source`: `Buffer \| string \| Readable \| AsyncIterable`. `opts`: `{ ttl, meta, reads }` |
| `store(entry, source)` | `Promise<boolean>` | Replication insert (§4.4): the caller supplies the full `Entry`, and the digest is verified as the bytes stream. `false` means the write was refused or was a no-op. |
| `pop(ref)` | `Promise<Readable>` | Destructive: claims the entry, streams it, and deletes it once the stream drains. Ignores any read budget; a pop is always terminal. |
| `apply(ref)` | `Promise<Readable>` | Non-destructive, unless the entry carries a read budget (§4.1). Digest-verified. |
| `show(ref)` | `Promise<Entry>` | Metadata only, never the contents. |
| `has(ref)` | `Promise<boolean>` | Existence check without the try/catch that `show` needs. An expired entry reads as `false`. |
| `list(opts?)` | `Promise<Entry[]>` | Metadata only. `opts`: `{ includeExpired }`. |
| `tombstones()` | `Promise<Tombstone[]>` | `{ id, destroyedAt, cause }[]`, for reconciliation. |
| `drop(ref)` | `Promise<boolean>` | Delete without reading. `false` if the ref names nothing. |
| `clear()` | `Promise<number>` | Delete everything; returns the count. |
| `prune()` | `Promise<number>` | Delete expired entries only; returns the count. |
| `stats()` | `Promise<Stats>` | `{ entries, bytes, claimed }`: aggregates only, never refs. |
| `verify(opts?)` | `Promise<Report>` | Audit: digest-checks blobs and finds orphaned `.tmp` files, meta/blob halves, and stale claims. Dry-run by default; `{ repair: true }` removes what it finds. |
| `close()` | `Promise<void>` | Stops the sweep timer. Idempotent. |
| `[Symbol.asyncIterator]()` | `AsyncIterator<Entry>` | `for await (const entry of stash)`, shorthand for `list()`. |

`push`, `pop`, `apply`, `show`, `list`, `drop`, `clear`, and `store` are the `git stash` verb
set — `store` maps to `git stash store`, the plumbing command scripts use to file an
already-made stash, which is the role it plays here too. Naming them after git stash protects
the lifecycle: don't add lifecycle verbs git doesn't have, and don't rename `pop` to `take` or
`consume`. The remaining methods (`has`, `stats`, `verify`, `tombstones`, `prune`, `close`) are
queries and maintenance; they inspect or clean up the store but never move bytes in or out. A
new method has to fit one of those two groups.

### Entry

```js
{
  id: 'v1_8f3a...',    // the ref
  size: 40213,          // bytes
  digest: 'sha256:...', // integrity only — NOT the lookup key
  createdAt: 1752451200000,
  expiresAt: 1752537600000,  // null if no TTL
  reads: 3,             // read budget; null = unlimited
  readsLeft: 2,         // remaining; decremented only by fully-drained applies
  meta: { /* caller-supplied, opaque, never interpreted */ }
}
```

`meta` is round-tripped verbatim as JSON. StashJS never reads, validates, indexes, or logs it.
A caller might keep an encrypted filename in there, for instance; StashJS doesn't look.

### 4.1 Read budgets

Every tool of this kind that lasted converged on the same control: expire after N retrievals,
not only after some amount of time. Firefox Send made 1–100 downloads its signature feature,
and Jirafeau and Gokapi both have it. `push(source, { reads: 3 })` provides it at this layer.

The semantics:

- A budgeted `apply` spends one credit only when the stream fully drains and the digest
  matches. An abandoned or failed read costs nothing. (Send counted download *attempts*, so a
  flaky connection could burn a recipient's only chance; this counts completions instead.)
- The read that takes `readsLeft` to zero destroys the entry through the same commit path as
  `pop` (§6).
- Budgeted applies serialize through the §6 claim mechanism, so two concurrent reads can't both
  spend the last credit. Unbudgeted applies stay lock-free, so the common path isn't slowed by
  the feature.
- `pop` ignores the budget; a pop is always terminal.
- The default is `reads: null`, meaning unlimited.

### 4.2 The monotone rule

Entries are write-once, and their lifecycle only moves one direction: **every change to an
entry moves it toward destruction, never away from it.** `readsLeft` only decrements, claims
only resolve, and expiry only arrives.

That's why there is no `touch()`, no `extendTTL()`, and no way to update metadata. Mutable
expiry, the way a cache does it, is wrong here: an entry whose terms can be extended is a
retention liability rather than something that reliably goes away. Changing the terms means a
new push. The rule also settles future features — anything that would let an entry outlive the
terms it was pushed with is rejected.

### 4.3 Events

`Stash` extends `node:events` `EventEmitter`:

| Event | Payload | Fires |
|---|---|---|
| `'pushed'` | `Entry` | After a push commits. |
| `'popped'` | `Entry` | After a pop's delete commits. |
| `'dropped'` | `Entry` | After `drop` / `clear` / a spent read budget. |
| `'expired'` | `Entry` | Once per entry — whether the lazy read path or the sweeper found it first. |
| `'sweepError'` | `Error` | A background `prune()` threw. |

Two things here aren't negotiable. First, the event is `'sweepError'`, never `'error'`: an
unhandled `'error'` event crashes the Node process, and a failing background sweep must not be
able to bring the application down. Second, it closes a gap — `sweepInterval` runs `prune()` on
a timer, and a sweep that throws otherwise has nowhere to report. More broadly, a caller often
needs to observe retrievals and expiries — for "your file was picked up" notices or an audit
trail — which older tools of this kind couldn't do at all, so StashJS emits the events and the
caller decides what to do with them.

Payloads are full `Entry` objects. The application already owns the store, so a ref in an event
it receives isn't a leak; §10's rule still governs what the application writes to its own logs.

### 4.4 Replication primitives

Replication — two instances mirroring one stash over the caller's own transport — is the second
use case StashJS supports. It ships only the primitives replication needs and none of the
machinery: no sockets, no wire format, no schedule. The daemon, the transport, and the topology
are the caller's.

Replication is in tension with the rest of the store. It copies bytes, while `pop` promises to
destroy them, and a naive sync brings the destroyed back: node A pops an entry, node B still
has it, and the next reconciliation copies it back onto A. The features in this section exist to
make that survivable.

**Tombstones.** Any early destruction — `pop`, `drop`, `clear`, or a spent read budget — writes
a tombstone of `{ id, destroyedAt, cause }` and nothing more: no digest, no size, no `meta`. A
tombstone only needs to say "never accept this id again," and recording what the entry was would
leak the content the destruction was meant to remove. Expiry writes no tombstone, because the
terms travel with the entry (see `store`) and every replica reaches the same deadline on its own
clock. Only a destruction that isn't already encoded in the entry needs a record.

Tombstones are pruned after `tombstoneTtl` (a constructor option, default `'30d'`). This is the
one setting the deployment has to get right: `tombstoneTtl` must comfortably exceed the longest
gap between reconciliations, or a forgotten tombstone lets an id come back. StashJS doesn't know
the sync schedule, so it can't enforce this.

**`store(entry, source)`** is the replication-grade insert, and it's a git verb too: `git stash
store` files an already-created stash, which is the role it plays here. Where `push` mints a new
identity, `store` preserves an existing one — the caller supplies the complete `Entry` (id,
`createdAt`, `expiresAt`, `reads`, `readsLeft`, `digest`, `meta`), and the bytes are checked
against the supplied digest as they stream, so transfer corruption is caught on the way in.

`store` proceeds in this order:

1. reject a malformed id (`InvalidRef`, the §5 whitelist — replication input is still input);
2. refuse a tombstoned id: return `false` and write nothing, since a tombstoned id must never
   come back;
3. no-op an entry whose `expiresAt` has already passed;
4. no-op an identical live entry (same id, same digest), so retrying a sync is free;
5. throw `IntegrityError` on a digest conflict (same id, different bytes) — that's corruption,
   not a merge;
6. otherwise write exactly like `push`, except every field is the caller's.

`store` emits no event. A sync daemon that heard its own writes would echo them back
indefinitely, so keeping `store` silent removes that class of bug rather than leaving every
caller to work around it.

**What replication costs (document this for the caller, not just here).** A read budget is
enforced per store. Two replicas holding a `reads: 1` entry can each serve one full read before
their tombstones converge, so exactly-once becomes eventually-once. For a burn-after-read drop,
that tradeoff has to be a deliberate choice. The safe topology is cold standby: replicate for
durability, serve every read from one node, and let tombstones propagate outward. Serving reads
from more than one node accepts the weaker guarantee, and that should be a decision made on
purpose.

---

## 5. Refs are random, not content hashes

The obvious design is `ref = sha256(contents)`, and it's the wrong one here, for two reasons.

The first is that it leaks. A content hash is guessable by anyone who has the content: if you
suspect someone stashed a particular document, you hash it and probe for the ref. That's an
enumeration oracle against exactly the kind of anonymous drop this store is meant to protect.

The second is that it gains nothing. The usual payoff is dedup, and dedup doesn't work on
ciphertext — two uploads of the same file are two different byte streams, with nothing to
deduplicate.

So the ref is a capability, not an address.

- `id = 'v1_' + randomBytes(32).toString('base64url')` — 256 bits, unguessable.
- The version prefix is for future format migration.
- `digest` is computed during the write stream and stored in metadata, used **only** to verify
  integrity on read. It is never a lookup key and never appears in an API surface that accepts
  it as input.
- Ref comparison, wherever it happens, uses `timingSafeEqual`.

Because refs become filenames, validating a ref is also the path-traversal defense. Every ref
entering a public method is checked *before it touches the filesystem*: it must match
`/^v1_[A-Za-z0-9_-]{43}$/` exactly, or it's `InvalidRef`. No normalization, no `path.resolve`
rescue, no attempt to clean it up and carry on. This is a whitelist and stays one, so
`../../etc/shadow` is rejected at the regex, before any syscall runs.

---

## 6. `pop` is the hard part

A naive `pop` deletes the entry and streams the file. If the client's connection drops at 60%,
the data is gone and the reader got half a file — data loss built into the design.

So `pop` is a claim → stream → commit cycle:

1. **Claim.** Atomically move the entry to a claimed state with `fs.rename` (atomic on POSIX
   within a filesystem). This doubles as the concurrency guard: two simultaneous `pop(ref)`
   calls race on the rename, one wins, and the loser gets `RefClaimed`. A pop is once-only, and
   that's enforced at the filesystem rather than with an in-process lock.
2. **Stream.** Read from the claimed path, verifying `digest` as the bytes pass.
3. **Commit.** On stream `end`, once the bytes are fully drained and the digest matches, delete.
4. **Fail.** On stream `error`, a premature `destroy`, or a digest mismatch, apply the
   `onPopFailure` policy.

### `onPopFailure`

- `'restore'` **(default)** — rename the entry back. It survives and the read can be retried.
  Losing data by default would be hostile.
- `'burn'` — delete it anyway, on the assumption that any read attempt means the bytes may have
  been observed and the entry shouldn't survive to be read again. This must be opt-in.

### Crash recovery

If the process dies mid-`pop`, claimed entries are left orphaned. On the first operation after
construction, `Stash` scans for claims older than `claimTimeout` (default `10m`) and resolves
each per `onPopFailure`. The scan is lazy — it runs on first use, not in the constructor,
because constructors don't do I/O.

---

## 7. Expiry

- `ttl` accepts `'30m'`, `'24h'`, `'7d'`, or a number of milliseconds. It's a construct-time
  default, overridable per `push`; `null` means no expiry.
- **Lazy.** `pop`, `apply`, and `show` treat an expired entry as `RefNotFound` and delete it in
  passing, so an expired entry is never served even if the sweeper hasn't run.
- **Swept.** `prune()` reaps expired entries on demand, and `sweepInterval` starts a timer that
  calls it.
- **The sweep timer is `.unref()`'d,** so it never holds the event loop open and keeps the
  caller's process from exiting. Forgetting this is a common way for a library like this to
  hang someone's process on shutdown.
- `close()` clears the timer.

### 7.1 Disposal

V8 13.6 on Node 24 ships explicit resource management, so `Stash` implements
`Symbol.asyncDispose` as an alias for `close()`:

```js
{
  await using stash = new Stash({ backend, ttl: '1h' });
  const ref = await stash.push(data);
}  // close() called automatically, timer cleared, even if the block throws
```

Two caveats, both meaning this is additive and **does not replace the `unref()` rule**:

- `await using` can't appear at module top level, and a long-lived `Stash` is often held at
  module scope. So the real path on shutdown is still an explicit `close()`, with `unref()`
  covering the cases where someone forgets.
- `Symbol.asyncDispose` must be idempotent — disposing twice is normal, not an error.

It's mainly for scripts and tests, where it replaces the `try/finally` around every test that
needs a live `Stash`.

---

## 8. Limits

- `maxSize` is per entry, enforced **during** the write stream: count bytes as they pass and,
  the moment the limit is crossed, destroy the stream and clean up the partial. Never write the
  whole blob and then check its size.
- `maxEntries` and `maxTotal` are stash-wide; a push that would exceed either rejects with
  `StashFull`. Without them, a caller is one loop away from filling the disk.
- On any rejected `push`, partial writes are cleaned up, so a failed push leaves nothing behind.

---

## 9. Backend interface

The backend is the only part that touches storage: `Stash` holds the policy and the backend
holds the bytes.

```js
{
  async write(id, readable, entry) {},  // → Entry (with size + digest computed)
  async read(id) {},                    // → Readable
  async claim(id) {},                   // atomic; throws RefClaimed if already claimed
  async restore(id) {},                 // undo a claim
  async commit(id) {},                  // finalize a claim (delete)
  async remove(id) {},                  // → boolean
  async stat(id) {},                    // → Entry
  async list() {},                      // → Entry[]
  async listClaims() {},                // → { id, claimedAt }[]  (for recovery)
  async stats() {},                     // → { entries, bytes, claimed }
  async consumeRead(id) {},             // atomic readsLeft decrement → remaining
  async writeTombstone(id, t) {},       // { destroyedAt, cause }
  async hasTombstone(id) {},            // → boolean
  async listTombstones() {},            // → Tombstone[]
  async verify(opts) {},                // integrity + orphan audit → report; repair opt-in
}
```

**DiskBackend** — layout:

```
.stash/
├── blobs/<id>          # raw bytes, mode 0600
├── meta/<id>.json      # sidecar Entry, mode 0600
├── claims/<id>         # claimed blobs live here
└── tombstones/<id>.json # id + destroyedAt + cause — nothing else
```

Metadata lives in per-entry sidecar files rather than a central index: there's no index to
corrupt and no lock contention, `list()` is a `readdir` plus a read, and the layout is
crash-safe.

Writes go to `blobs/<id>.tmp` and are `fs.rename`d into place, so a reader never sees a partial
blob. Directories are mode `0700` and files `0600`; nothing is world-readable.

**StashJS does its own containment check.** Per §2.1 the permission model follows symlinks out
of granted paths, so `--allow-fs-read=./.stash/*` doesn't actually confine the process if
something plants a symlink in the root. On construction, `realpath` the root and store it. On
every resolved blob/meta/claim path, `realpath` the parent and check it's still under that root,
refusing with `InvalidRef` otherwise. Use `fs.lstat`, not `fs.stat`, to check whether an entry
exists, so a symlink standing in for a blob is treated as corruption rather than a blob.

**MemoryBackend** implements the same interface backed by a `Map`, for tests, and doesn't
persist.

---

## 10. Errors

Typed, with stable `.code`. Consumers must never string-match a message.

| Class | `code` | When |
|---|---|---|
| `RefNotFound` | `ENOREF` | Unknown or expired ref |
| `RefClaimed` | `ECLAIMED` | Concurrent `pop` lost the race |
| `IntegrityError` | `EINTEGRITY` | Digest mismatch on read |
| `SizeExceeded` | `E2BIG` | `maxSize` crossed mid-stream |
| `StashFull` | `EFULL` | `maxEntries` / `maxTotal` reached |
| `InvalidRef` | `EBADREF` | Malformed ref string |

All extend `StashError`. **No error message ever contains a ref, a `meta` value, or a path** —
messages are for developers, and a ref is a capability that must not leak into one.

---

## 11. Repo layout

```
stashjs/
├── src/
│   ├── index.js          # exports Stash, errors
│   ├── stash.js          # policy: ttl, limits, claim lifecycle
│   ├── ref.js            # generate, validate, compare
│   ├── duration.js       # '24h' → ms
│   ├── errors.js
│   └── backends/
│       ├── disk.js
│       └── memory.js
├── test/
├── examples/
├── CLAUDE.md
├── SPEC.md
├── README.md
└── package.json
```

---

## 12. Milestones

Each milestone ends green and committed. Do not start the next until the current one's
tests pass. `pop` is deliberately last — it is the hard part and it needs everything
underneath it to be stable first.

**M1 — Skeleton.** `package.json` (engines, `.node-version`), `errors.js`, `ref.js` (generation
+ the §5 whitelist), `duration.js`, `MemoryBackend`. `push` / `apply` / `show` / `list` /
`drop` / `clear`. No TTL, no claims, no limits.
*Done when:* round-trip a Buffer and a Readable through memory, all errors typed, traversal
refs rejected.

**M2 — Disk.** `DiskBackend`. Sidecar metadata, tmp+rename writes, permissions, realpath
containment, streaming both directions, digest computed on write.
*Done when:* M1's test suite passes unmodified against both backends, and the whole suite passes
under `--permission` scoped to the test root.

**M3 — Expiry.** `duration` parsing, `expiresAt`, lazy expiry on read, `prune()`,
`sweepInterval`, `close()`, `Symbol.asyncDispose`.
*Done when:* an expired entry is unreadable before any sweep runs, and a process with an open
`Stash` exits on its own.

**M4 — Limits.** `maxSize` enforced mid-stream, `maxEntries` / `maxTotal`, partial cleanup on
rejection.
*Done when:* pushing an oversized stream aborts early and leaves no orphans on disk.

**M5 — Pop & budgets.** Claim/commit/restore, `onPopFailure`, concurrency, crash recovery,
integrity verification on read, read budgets (§4.1) on the same claim machinery.
*Done when:* concurrent pops yield exactly one winner; a `reads: 2` entry survives exactly two
full drains under concurrent readers; a killed process mid-pop recovers per policy on next
construction.

**M6 — Audit.** `has`, `stats`, `verify` (report + repair), the §4.3 event set including
`sweepError`.
*Done when:* a store seeded with a bit-flipped blob, an orphaned `.tmp`, and a meta-without-blob
surfaces all three in a `verify()` report and removes them only under `repair: true`.

**M7 — Replication.** Tombstones on every early-destruction path, `store()` with the §4.4
order of checks, `tombstones()`, `tombstoneTtl` pruning.
*Done when:* two `Stash` instances synced by a 20-line test harness converge — pops don't
resurrect, budgets converge to zero, and retrying an identical `store` is a no-op.

**M8 — Docs.** README, examples, JSDoc on the public surface. Examples include the
cold-standby sync sketch and the §2.1 permission flags.

---

## 13. Testing

`node:test` + `node:assert/strict`, run with plain `node --test`. No framework. Backends share
one conformance suite run against both — use 24.x's global `before` / `after` hooks for
fixture setup rather than hand-rolled wrappers, and `await using` for any test that needs a
live `Stash`.

Non-negotiable cases:

- Concurrent `pop(ref)` ×2 → exactly one stream, one `RefClaimed`.
- `pop` stream destroyed at 50% → entry restored (`'restore'`) / gone (`'burn'`).
- Process killed mid-`pop` → claim recovered on next construction.
- Expired entry → `RefNotFound` from `apply`, before any sweep.
- Oversized push → `SizeExceeded` before the source is fully consumed; no orphan files.
- Corrupted blob → `IntegrityError`, not silent bad bytes.
- `Stash` with `sweepInterval` set → process exits without `close()`.
- `Symbol.asyncDispose` called twice → no throw.
- Blob files are `0600`.
- Traversal refs (`../../etc/passwd`, `v1_..`, absolute paths, URL-encoded variants) →
  `InvalidRef`, with no syscall attempted.
- Symlink planted at `blobs/<id>` pointing outside the root → refused, not followed.
- Entry with `reads: 2` → exactly two fully-drained applies ever succeed, across concurrent
  attempts; the third caller gets `RefNotFound`.
- Abandoned read on a budgeted entry (stream destroyed at 50%) → budget unspent.
- `verify()` against planted corruption (bit-flipped blob, orphaned `.tmp`, meta-without-blob)
  → all three reported; nothing removed without `repair: true`.
- `'expired'` fires exactly once per entry whether the lazy read path or the sweeper wins.
- A throwing sweep emits `'sweepError'` and the process survives.
- `store()` of a tombstoned id → `false`, nothing written; two-store sim: pop on A, sync B→A,
  A stays empty. No resurrection.
- `store()` retried with an identical entry+digest → no-op; digest conflict → `IntegrityError`
  with no partial write.
- `store()` of an entry whose `expiresAt` has passed → no-op, nothing on disk.
- Two stores, `reads: 1` entry on both: one full read each succeeds (the documented eventual
  guarantee), and after tombstone exchange both stores are empty.
- Tombstones survive `prune()` until `tombstoneTtl`, then are pruned.

### 13.1 Executable invariants

Two checks matter enough to enforce mechanically, so they run in CI (and locally, wired into a
Stop hook). They turn §1 and §2 into something the build verifies rather than something a
contributor has to remember.

1. **A grep of the source for `createCipheriv`, `createDecipheriv`, `node:sqlite`, and
   `password` returns no matches.**
2. **The full suite passes under `--permission` with grants scoped to the test root only.** If a
   change quietly needs a broader grant, the sandbox catches it here, when the change is made,
   instead of in production.
