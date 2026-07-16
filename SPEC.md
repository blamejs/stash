# StashJS — Specification

**StashJS is a zero-dependency, ephemeral, crypto-agnostic content store for Node.js.**

You put bytes in. You get a ref back. You take the bytes out once, and they're gone.

It is the "bytes at rest" primitive of the suite, paired with Blamejs ("bytes in motion").
HermitStash is the first consumer. StashJS is a shelf; it has no opinion about what is on it.

---

## 1. The one rule

**StashJS can't decrypt anything. There's nowhere in it to put a key.**

There is no key parameter on any method. There is no cipher import anywhere in the source
tree. There is no `decrypt` option, no `secret`, no `passphrase`. Not because it would be
insecure, but because the *absence of the capability* is the product.

A store that chooses not to decrypt is a promise. A store with nowhere for a key to live is
an architecture. When the threat model is "someone compels the operator," only the second one
survives. Encryption is HermitStash's job, because HermitStash is the thing with a threat
model. StashJS is a shelf.

`node:crypto` may be imported for **hashing and random ID generation only** —
`createHash`, `randomBytes`, `timingSafeEqual`. Never `createCipheriv` or `createDecipheriv`.

If a task seems to require StashJS to understand the contents of a blob, the task is wrong.
Stop and ask.

---

## 2. Runtime and non-negotiable constraints

- **Node 24.18.0.** Pinned to match Blamejs. `"engines": { "node": ">=24.18.0" }`, and a
  `.node-version` / `.nvmrc` containing `24.18.0`. Target it as a floor, not a ceiling —
  no polyfills, no compat shims, no `if (nodeVersion < x)` branches for older runtimes.
- **Zero dependencies.** Not one runtime dependency. Not one dev dependency. Node builtins
  only. Tests use `node:test` and `node:assert`. If a task cannot be completed without adding
  a package, stop and ask rather than adding it.
- **ESM only.** `"type": "module"`. Plain JavaScript. No TypeScript, no build step, no
  transpilation, no bundler. Types, if ever, ship as hand-written `.d.ts` — not now.
- **Streaming-first.** No method may buffer an entire blob in memory. Size limits are enforced
  *mid-stream*, not by reading the file to find out how big it was.

### 2.1 Permission model posture

The Node permission model went stable in 23.5, so on 24.18.0 it's `--permission`, not
`--experimental-permission`. StashJS should be designed to run cleanly under:

```
node --permission --allow-fs-read=./.stash/* --allow-fs-write=./.stash/* app.js
```

This is the same argument as §1, enforced by the runtime instead of by discipline: the process
holding the blobs can be locked to the directory holding the blobs and nothing else. A
compromised dependency elsewhere in the consumer's tree cannot read the stash, and StashJS
cannot read anything else.

Design implications, all mandatory:

- **No child processes, no worker threads, no native addons, no WASI.** Each would need its own
  `--allow-*` grant and each widens the sandbox. StashJS needs none of them.
- **Symlinks are followed even outside granted paths** — this is a documented limitation of the
  permission model, not a bug we can wait out. So the DiskBackend must do its own containment
  check (§9). The sandbox does not do it for us.
- **Existing file descriptors bypass the model.** Never accept an fd as an input. Paths only.
- Do not call `process.permission.has()` to branch behavior. If the grant is wrong, let the
  `ERR_ACCESS_DENIED` surface. A library that silently degrades when sandboxed is worse than
  one that fails loudly.
- `--permission` in 24.x does **not** gate the network. Do not claim in the README that it
  does. StashJS opens no sockets regardless, which is the actual guarantee.

Ship the flags in `examples/` and in the README. It's the cheapest security win in the project
and most consumers won't know it exists.

---

## 3. Do not build these

This section is load-bearing. Each of these will feel helpful and is wrong.

- **No encryption.** See §1.
- **No content addressing / dedup.** Refs are random, not content hashes. Reasoning in §5 —
  read it before "improving" this.
- **No compression.** The payload is ciphertext. It will not compress, and compressing before
  encryption is a CRIME/BREACH-class leak. Not our layer either way.
- **No `node:sqlite` index.** This one is new and will be tempting: it's a builtin, so it does
  not violate §2's zero-dependency rule on a technicality. Reject it anyway. It's still
  experimental on 24.x, sidecar files already win on crash-safety (§9), and — decisively — the
  permission model does not gate filesystem access made through `node:sqlite`. Adopting it
  would punch a hole straight through §2.1. The one builtin that could plausibly earn its way
  in is the one that quietly disables the sandbox.
- **No mimetype sniffing, no content inspection, no thumbnailing, no virus scanning.** Opaque
  bytes.
- **No HTTP server, no routes, no multipart parsing.** That's HermitStash.
- **No cloud backends.** Disk and memory. That's it for v1.
- **No eviction.** lru-cache and ttl-set evict to make room, and it's the right call for a
  cache: cache entries are hints. Stash entries are promises. A store that silently destroys
  the oldest entry when full turns a push flood into an attack on other people's data — for a
  whistleblower drop, that's a denial-of-evidence primitive. When full, `push` fails loudly
  with `StashFull`. The rejection is the feature.
- **No `touch()` / TTL extension / metadata mutation.** See the monotone rule (§4.2).
- **No namespaces.** keyv-style logical partitions inside one store add key-prefix machinery
  for something two `Stash` instances with two roots already do with zero magic.
- **No sync transport, no oplog.** Replication support is §4.4's tombstones and `store()` —
  the wire, the schedule, and the topology belong to the consumer. And no change journal:
  full-scan anti-entropy over `list()` + `tombstones()` is cheap at `maxEntries` scale, while
  a journal is exactly the kind of central mutable file the sidecar design (§9) exists to
  avoid.
- **No logging of refs or metadata values.** A ref is a capability. A ref in a log file is a
  leaked capability. Log counts and error codes, never identifiers or `meta` contents.
- **No telemetry, no analytics, no phoning home.**

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
| `store(entry, source)` | `Promise<boolean>` | Replication insert (§4.4): caller supplies the full `Entry`, digest verified in-stream. `false` = refused or no-op. |
| `pop(ref)` | `Promise<Readable>` | **Destructive.** Claims, streams, deletes on successful drain. Ignores any read budget — pop is always terminal. |
| `apply(ref)` | `Promise<Readable>` | Non-destructive — unless the entry carries a read budget (§4.1). Digest-verified. |
| `show(ref)` | `Promise<Entry>` | Metadata only. Never contents. |
| `has(ref)` | `Promise<boolean>` | Existence check without the try/catch ceremony of `show`. Expired = `false`. |
| `list(opts?)` | `Promise<Entry[]>` | Metadata only. `opts`: `{ includeExpired }` |
| `tombstones()` | `Promise<Tombstone[]>` | `{ id, destroyedAt, cause }[]` — the graves, for reconciliation. |
| `drop(ref)` | `Promise<boolean>` | Delete without reading. `false` if absent. |
| `clear()` | `Promise<number>` | Drop everything. Returns count. |
| `prune()` | `Promise<number>` | Drop expired only. Returns count. |
| `stats()` | `Promise<Stats>` | `{ entries, bytes, claimed }` — aggregates only, never refs. |
| `verify(opts?)` | `Promise<Report>` | Audit: digest-checks blobs, finds orphaned `.tmp`/meta/blob halves, stale claims. Dry-run by default; `{ repair: true }` removes what it condemns. |
| `close()` | `Promise<void>` | Stops the sweep timer. Idempotent. |
| `[Symbol.asyncIterator]()` | `AsyncIterator<Entry>` | `for await (const entry of stash)` — sugar over `list()`. |

`push` / `pop` / `apply` / `show` / `list` / `drop` / `clear` / `store` are the `git stash`
verb set — `store` via the plumbing side (`git stash store`, the script-facing insert), which
is exactly the register it occupies here — and that correspondence is the point of the name.
The rule protects the *lifecycle*: do not add lifecycle verbs git doesn't have, and do not
rename `pop` to `take` or `consume`. The non-git methods (`has`, `stats`, `verify`,
`tombstones`, `prune`, `close`) are queries and janitorial work — they inspect or maintain the
shelf, they never move bytes on or off it. Anything new must land cleanly in one of those two
buckets or it doesn't land.

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

`meta` is round-tripped verbatim as JSON. StashJS does not read it, validate it, index it, or
log it. HermitStash puts an encrypted filename blob in there; that is none of our business.

### 4.1 Read budgets

Every tool in this space that survived contact with users converged on the same control:
expire after N retrievals, not just after T time. Firefox Send made 1–100 downloads its
signature feature; Jirafeau and Gokapi both carry it. `push(source, { reads: 3 })` is that
control at the primitive layer.

Semantics, precisely:

- A budgeted `apply` spends one credit **only when the stream fully drains and the digest
  matches.** An abandoned or failed read costs nothing — Send counts download *attempts*,
  which means a flaky connection can burn a recipient's only chance. We count completions.
- The read that takes `readsLeft` to zero destroys the entry through the same commit path as
  `pop` (§6). Nothing new to get wrong.
- Budgeted applies serialize through the §6 claim mechanism, so two concurrent reads cannot
  both spend the last credit. Unbudgeted applies stay lock-free — the common path pays nothing
  for the feature.
- `pop` ignores the budget. Pop is terminal by definition.
- Default is `reads: null` — unlimited.

### 4.2 The monotone rule

Entries are write-once, and their lifecycle is monotone: **every state change moves an entry
closer to destruction, never further.** `readsLeft` only decrements. Claims only resolve.
Expiry only arrives.

This is why there is no `touch()`, no `extendTTL()`, no metadata update — ttlcache-style
mutable expiry is right for a cache and wrong here, because an entry that can be argued back
from the brink is a retention liability, not a stash. New terms mean a new push. The rule also
draws the line for future features: anything that would let an entry live longer than its
terms at push time is rejected on sight.

### 4.3 Events

`Stash` extends `node:events` `EventEmitter`:

| Event | Payload | Fires |
|---|---|---|
| `'pushed'` | `Entry` | After a push commits. |
| `'popped'` | `Entry` | After a pop's delete commits. |
| `'dropped'` | `Entry` | After `drop` / `clear` / a spent read budget. |
| `'expired'` | `Entry` | Once per entry — whether the lazy read path or the sweeper found it first. |
| `'sweepError'` | `Error` | A background `prune()` threw. |

Two design points that are not optional. The name is `'sweepError'`, **never `'error'`** — an
unhandled `'error'` event crashes a Node process, and a background janitor must not be able to
take the app down. And it exists because the current design had a hole: `sweepInterval` runs
`prune()` on a timer, and until now a failing sweep had nowhere to report. Jirafeau's biggest
gap after 18 years is that nothing can observe a retrieval or an expiry; HermitStash needs
exactly that for "your file was picked up" and for audit trails, so the primitive emits and the
app decides.

Payloads are full `Entry` objects — the embedder owns the store, so refs in events are not a
leak. §10's rule still applies to what the *embedder* writes to logs.

### 4.4 Replication primitives

HermitStash sync — two instances mirroring one stash over the operator's own transport — is
the second consumer. StashJS ships the primitives sync needs and none of the machinery: no
sockets, no wire format, no schedule. The daemon is HermitStash's, the transport is Blamejs's,
and the store stays a shelf.

Sync collides with this store's whole point. Replication copies bytes; `pop` promises their
destruction; and naive sync *resurrects the dead* — node A pops an entry, node B still holds
it, the next reconciliation copies it straight back onto A. Every feature in this section
exists to make that collision survivable.

**Tombstones.** Early destruction — `pop`, `drop`, `clear`, a spent read budget — writes a
tombstone: `{ id, destroyedAt, cause }`. Nothing else. No digest, no size, no `meta` — a
tombstone that describes the body defeats the burial. It exists to say "never accept this id
again," not to memorialize what the id was. Expiry writes no tombstone: terms travel with the
entry (see `store`), so every replica reaches the same deadline on its own clock. Only violent
death needs a witness.

Tombstones are pruned after `tombstoneTtl` (constructor option, default `'30d'`), and the
floor rule is the one knob the deployment must own: `tombstoneTtl` must comfortably exceed the
longest gap between reconciliations, or forgotten graves start resurrecting. StashJS cannot
know the sync schedule, so it cannot enforce this.

**`store(entry, source)`** is the replication-grade insert — and still a git verb: `git stash
store` is the plumbing command scripts use to file an already-created stash, which is
precisely the register this method lives in. Where `push` mints identity, `store` preserves
it: the caller supplies the complete `Entry` — id, `createdAt`, `expiresAt`, `reads`,
`readsLeft`, `digest`, `meta` — and the bytes are verified against the supplied digest as they
stream, so transfer corruption dies at the door.

In order, `store`:

1. rejects a malformed id (`InvalidRef`, the §5 whitelist — replication input is still input);
2. refuses a tombstoned id — returns `false`, writes nothing. Destruction is monotone across
   replicas: a tombstoned id never lives again;
3. no-ops an entry whose `expiresAt` has already passed — the dead travel as dead;
4. no-ops an identical live entry (same id, same digest) — idempotent, so retry-based sync is
   free;
5. throws `IntegrityError` on a digest conflict (same id, different bytes) — that is not a
   merge case, it is corruption;
6. otherwise writes exactly like `push`, except every field is the caller's.

`store` emits **no event.** A sync daemon that hears its own writes echoes them back forever;
a silent `store` deletes the echo-suppression bug class instead of asking every consumer to
solve it.

**What sync costs — put this in HermitStash's docs, not just here.** A read budget is enforced
per store. Two replicas holding a `reads: 1` entry can each serve one full read before
tombstones converge: exactly-once degrades to *eventually*-once. For a burn-after-read drop,
that trade must be chosen, not discovered. The clean topology is cold standby — replicate for
durability, serve every read from one node, let tombstones flow outward. Serving reads from
more than one node is a decision to accept the weaker guarantee, and it should be made in
writing.

---

## 5. Refs are random, not content hashes

The obvious design is `ref = sha256(contents)`. It is wrong here, for two reasons:

1. **It leaks.** A content hash is guessable by anyone who has the content. If I suspect you
   stashed a particular document, I hash it and probe for the ref. That's an enumeration
   oracle against a whistleblower drop — the exact thing HermitStash exists to prevent.
2. **It buys nothing.** Dedup is the usual payoff, and dedup does not work on ciphertext. Two
   uploads of the same file are two different byte streams. There is nothing to deduplicate.

So: **the ref is a capability, not an address.**

- `id = 'v1_' + randomBytes(32).toString('base64url')` — 256 bits, unguessable.
- The version prefix is for future format migration.
- `digest` is computed during the write stream and stored in metadata, used **only** to verify
  integrity on read. It is never a lookup key and never appears in an API surface that accepts
  it as input.
- Ref comparison, wherever it happens, uses `timingSafeEqual`.

**Refs become filenames, so ref validation is path-traversal defense.** Every ref entering a
public method is validated *before it touches the filesystem*: it must match
`/^v1_[A-Za-z0-9_-]{43}$/` exactly, or it's `InvalidRef`. No normalization, no `path.resolve`
rescue, no "clean it up and continue" — a ref that isn't character-for-character well-formed is
not a ref. This is a whitelist and it stays a whitelist. `../../etc/shadow` must die at the
regex, not at the syscall.

---

## 6. `pop` is the hard part

Naive `pop` deletes the entry and streams the file. Then the client's connection drops at 60%,
and the data is gone forever while the reader got half a file. That is data loss by design.

`pop` must be a claim → stream → commit cycle:

1. **Claim.** Atomically move the entry to a claimed state (`fs.rename` — atomic on POSIX
   within a filesystem). This is the concurrency guard: two simultaneous `pop(ref)` calls
   race on the rename, exactly one wins, the loser gets `RefClaimed`. Pop is once-only by
   definition; enforce it at the filesystem, not with an in-process lock.
2. **Stream.** Read from the claimed path, verifying `digest` incrementally.
3. **Commit.** On stream `end` — fully drained, digest matched — delete.
4. **Fail.** On stream `error`, premature `destroy`, or digest mismatch — apply the
   `onPopFailure` policy.

### `onPopFailure`

- `'restore'` **(default)** — rename back. The entry survives; the read can be retried. Losing
  data by default is hostile.
- `'burn'` — delete anyway. For the paranoid drop: assume any read attempt means the bytes
  were observed, so the entry must not survive to be read again. HermitStash will likely want
  this. It must be opt-in.

### Crash recovery

If the process dies mid-`pop`, claimed entries are orphaned. On construction, `Stash` scans for
claims older than `claimTimeout` (default `10m`) and resolves them per `onPopFailure`. This
scan is lazy — triggered on first operation, not in the constructor. Constructors do not do
I/O.

---

## 7. Expiry

- `ttl` accepts `'30m'`, `'24h'`, `'7d'`, or a number of ms. Construct-time default,
  overridable per-`push`. `null` means no expiry.
- **Lazy:** `pop` / `apply` / `show` treat an expired entry as `RefNotFound` and drop it in
  passing. An expired entry is never served, even if the sweeper hasn't run.
- **Swept:** `prune()` sweeps on demand. `sweepInterval` starts a timer that calls it.
- **The sweep timer must be `.unref()`'d.** Otherwise it holds the event loop open and every
  consumer's process hangs on exit. This is the single most common way a library like this
  ruins someone's afternoon.
- `close()` clears the timer.

### 7.1 Disposal

V8 13.6 on Node 24 ships explicit resource management natively, so `Stash` implements
`Symbol.asyncDispose` as an alias for `close()`:

```js
{
  await using stash = new Stash({ backend, ttl: '1h' });
  const ref = await stash.push(data);
}  // close() called automatically, timer cleared, even if the block throws
```

Two caveats, both of which mean this is additive and **does not replace the `unref()` rule**:

- `await using` can't appear at module top level, and HermitStash will hold a long-lived `Stash`
  at module scope. So the real-world path is still an explicit `close()` on shutdown, with
  `unref()` covering everyone who forgets.
- `Symbol.asyncDispose` must be idempotent. Disposal running twice is normal, not an error.

Treat it as ergonomics for scripts and tests — where it genuinely earns its place, since it
kills the `try/finally` in every test that needs a live `Stash`.

---

## 8. Limits

- `maxSize` — per entry. Enforced **during** the write stream: count bytes as they pass, and
  destroy the stream + clean up the partial the moment the limit is crossed. Never write the
  whole thing and then check.
- `maxEntries` / `maxTotal` — stash-wide. `push` rejects with `StashFull`. Without this,
  HermitStash is one curl loop away from a full disk.
- On any rejected `push`, partial writes are cleaned up. A failed push leaves nothing behind.

---

## 9. Backend interface

The backend is the only thing that touches storage. `Stash` holds the policy; the backend holds
the bytes.

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

Sidecar metadata over a central index: no index to corrupt, no lock contention, `list()` is a
`readdir` + read. Crash-safe by construction. Fast enough.

Writes go to `blobs/<id>.tmp` then `fs.rename` into place. A reader never sees a partial blob.
Directory mode `0700`, file mode `0600`. Never world-readable.

**Containment is our job, not the sandbox's.** Per §2.1 the permission model follows symlinks
out of granted paths, so `--allow-fs-read=./.stash/*` does not actually confine us if something
plants a symlink in the root. On construction, `realpath` the root and store it. On every
resolved blob/meta/claim path, `realpath` the parent and assert it's still under that root —
refuse with `InvalidRef` otherwise. Use `fs.lstat`, not `fs.stat`, when checking whether an
entry exists: a symlink where a blob should be is corruption, not a blob.

**MemoryBackend** — same interface, `Map`-backed, for tests. No persistence, no pretense.

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

All extend `StashError`. **No error message ever contains a ref, a `meta` value, or a path.**
Error messages are for developers; refs are capabilities. Keep them apart.

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

One milestone per session. Each ends green and committed. Do not start the next until the
current one's tests pass. `pop` is deliberately last — it is the hard part and it needs
everything underneath it to be stable first.

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

These two are the ones that survive a long agentic session where the prose has scrolled out of
context. Wire them into CI and a Stop hook — they're §1 and §2 turned into something a machine
enforces rather than something a model remembers.

1. **Grep the source for `createCipheriv`, `createDecipheriv`, `node:sqlite`, and `password`.
   Zero hits.** This test is not a joke.
2. **The full suite passes under `--permission` with grants scoped to the test root only.** If
   a change quietly requires a broader grant, the sandbox catches it at the point the change is
   made, rather than at the point someone deploys it.
