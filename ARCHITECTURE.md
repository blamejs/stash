# @blamejs/stash architecture

A contributor's guide to where things live and why the pieces are shaped the way they are. This doc is the orientation map; the authoritative contract is [SPEC.md](SPEC.md), and the contributor disciplines are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Top-level layout

```
stashjs/
|-- src/
|   |-- index.js          # Single export surface -- Stash + the typed errors
|   |-- stash.js          # Policy layer: TTL, limits, read budgets, claim lifecycle, events
|   |-- ref.js            # Ref generation, whitelist validation, timing-safe comparison
|   |-- duration.js       # '24h' -> milliseconds
|   |-- errors.js         # StashError base + the typed subclasses with stable codes
|   `-- backends/
|       |-- memory.js     # Map-backed backend -- shipped
|       `-- disk.js       # Sidecar-file backend -- specified (SPEC.md section 9), not yet built
|-- test/                 # node:test suites; one conformance suite shared across backends
|-- examples/
|-- SPEC.md               # The contract
`-- package.json
```

Consumers use one import:

```js
import { Stash } from '@blamejs/stash';
import { MemoryBackend } from '@blamejs/stash/backends/memory';

const stash = new Stash({ backend: new MemoryBackend() });
const ref = await stash.push(bytes);
const entry = await stash.show(ref);
```

## The two layers: policy and backend

The load-bearing split is SPEC.md section 9: **`Stash` holds the policy; the backend holds the bytes.** The backend is the only thing that touches storage.

- **`Stash` (src/stash.js)** owns everything that is a decision: TTL and expiry, size and count limits, read-budget accounting, the claim lifecycle for destructive reads, the `onPopFailure` policy, event emission, and ref validation at every public entry point.
- **A backend** implements a flat async interface -- `write` / `read` / `claim` / `restore` / `commit` / `remove` / `stat` / `list` / `listClaims` / `stats` / `consumeRead` / `writeTombstone` / `hasTombstone` / `listTombstones` / `verify` -- and nothing else. It stores and retrieves; it does not decide.

Because the policy layer never touches storage directly, both backends run the same conformance test suite, and a behavior implemented once in `Stash` (lazy expiry, budget accounting, the claim cycle) cannot diverge between them.

Two backends are the complete v1 set -- disk and memory, per the spec's "no cloud backends" rule. **MemoryBackend** (shipped) is Map-backed with no persistence and no pretense; it exists so tests and consumers can exercise the full contract without a filesystem. **DiskBackend** (specified, not yet built) uses sidecar metadata files rather than a central index -- no index to corrupt, no lock contention, crash-safe by construction -- with tmp-write-then-rename so a reader never sees a partial blob, and `0700` / `0600` modes throughout.

## Refs are capabilities, not addresses

SPEC.md section 5 is the identity design, and it is deliberate:

- A ref is `'v1_' + randomBytes(32).toString('base64url')` -- 256 bits, unguessable. Refs are **not** content hashes: a content hash is guessable by anyone holding the content, which turns the store into an enumeration oracle, and dedup (the usual payoff) buys nothing when the payload is ciphertext.
- The `digest` on each entry is integrity-only. It is never a lookup key and never appears on an API surface that accepts it as input.
- Ref comparison uses `timingSafeEqual`.
- **Refs become filenames, so ref validation is path-traversal defense.** Every ref entering a public method must match `/^v1_[A-Za-z0-9_-]{43}$/` exactly before it touches anything, or it is `InvalidRef`. No normalization, no `path.resolve` rescue. A whitelist, and it stays a whitelist.

## `pop`: the claim -> stream -> commit cycle

Destructive reads are the hard part (SPEC.md section 6). A naive delete-then-stream loses data the moment a connection drops mid-read, so `pop` is a three-phase cycle:

1. **Claim.** Atomically move the entry to a claimed state (`fs.rename` on disk -- atomic within a filesystem). Two concurrent `pop(ref)` calls race on the rename; exactly one wins, the loser gets `RefClaimed`. Once-only is enforced at the filesystem, not with an in-process lock.
2. **Stream.** Read from the claimed location, verifying the digest incrementally.
3. **Commit.** On full drain with a matching digest -- delete.
4. **Fail.** On stream error, premature destroy, or digest mismatch -- apply `onPopFailure`: `'restore'` (default -- the entry survives, the read can be retried) or `'burn'` (opt-in -- any read attempt is treated as observation, so the entry must not survive).

Crash recovery rides the same machinery: claims older than `claimTimeout` are resolved per `onPopFailure` on the first operation after construction (lazily -- constructors do no I/O). Read budgets (SPEC.md section 4.1) reuse the claim path too: the read that spends the last credit destroys the entry through the same commit path as `pop`, so there is nothing new to get wrong.

## The monotone lifecycle

SPEC.md section 4.2: **every state change moves an entry closer to destruction, never further.** `readsLeft` only decrements; claims only resolve; expiry only arrives. There is no `touch()`, no TTL extension, no metadata mutation -- an entry that can be argued back from the brink is a retention liability, not a stash. New terms mean a new push. This rule is also the acceptance filter for future features: anything that would let an entry outlive its terms at push time is rejected on sight.

## Typed errors

Every failure is a typed class extending `StashError` with a stable `.code` (SPEC.md section 10): `RefNotFound`/`ENOREF`, `RefClaimed`/`ECLAIMED`, `IntegrityError`/`EINTEGRITY`, `SizeExceeded`/`E2BIG`, `StashFull`/`EFULL`, `InvalidRef`/`EBADREF`. Consumers branch on the code, never on message text -- and no message ever contains a ref, a `meta` value, or a path, because refs are capabilities and error text ends up in logs.

## The permission-model posture

The library is designed to run cleanly under Node's stable permission model (SPEC.md section 2.1):

```
node --permission --allow-fs-read=./.stash/* --allow-fs-write=./.stash/* app.js
```

This is the crypto-agnosticism argument enforced by the runtime instead of by discipline: the process holding the blobs can be locked to the directory holding the blobs and nothing else. The design implications are mandatory: no child processes, no worker threads, no native addons, no WASI (each would need its own grant); paths only, never file descriptors (fds bypass the model); no `process.permission.has()` branching -- if the grant is wrong, the `ERR_ACCESS_DENIED` surfaces loudly. The permission model follows symlinks out of granted paths, so symlink containment is the DiskBackend's own job (`realpath` the root at construction, assert every resolved path stays under it, `lstat` rather than `stat` so a planted symlink reads as corruption, not a blob). And `--permission` does not gate the network on this Node line -- the store opens no sockets regardless, which is the actual guarantee.

## Constraints the layout encodes

1. **Zero dependencies -- including dev dependencies.** Node builtins only; tests are `node:test` + `node:assert/strict` run with plain `node --test`.
2. **Crypto-agnostic.** `node:crypto` is imported for `createHash`, `randomBytes`, and `timingSafeEqual` only. There is no key parameter on any method and nowhere for one to live -- the store cannot decrypt what it holds, by construction.
3. **ESM, plain JavaScript, no build step.** What ships is what runs, on Node 24.18.0 as a floor.
4. **Streaming-first.** No method buffers an entire blob; limits are enforced mid-stream and a rejected write cleans up its partial.
5. **Fail loud.** When full, `push` throws `StashFull` -- there is no eviction, because stash entries are promises, not cache hints, and silently destroying the oldest entry would turn a push flood into an attack on other people's data.

## Explicit non-goals

SPEC.md section 3 is load-bearing and binds contributors and maintainer alike. The store will not grow: encryption; content addressing or dedup; compression; a `node:sqlite` index (still experimental, loses to sidecar files on crash-safety, and -- decisively -- its filesystem access bypasses the permission model); mimetype sniffing or any content inspection; an HTTP server; cloud backends; eviction; `touch()` / TTL extension / metadata mutation; namespaces; a sync transport or oplog; logging of refs or `meta` values; telemetry. Each entry has its reasoning in the spec -- read it before proposing the improvement.

## Implementation status

Honest map of built versus specified, tracking the milestone plan in SPEC.md section 12:

- **Built (M1 -- skeleton):** the typed errors, ref generation + whitelist validation, the `MemoryBackend`, and the `push` / `apply` / `show` / `list` / `drop` / `clear` verbs. No TTL, no claims, no limits yet.
- **Specified, not yet built (M2-M8):** the `DiskBackend` with realpath containment and the `--permission` gate (M2); expiry, `prune()`, the sweep timer, `Symbol.asyncDispose` (M3); `maxSize` / `maxEntries` / `maxTotal` enforcement (M4); `pop`, claims, `onPopFailure`, crash recovery, read budgets (M5); `has` / `stats` / `verify` and the event set (M6); tombstones and `store()` replication (M7); README and examples (M8).

Where this document describes M2+ behavior, it is describing the specification the implementation must meet, not shipped code.

## Where to read first

If you're new to the codebase, read in this order:

1. [SPEC.md](SPEC.md) -- the contract, including the "do not build these" list and the reasoning behind it.
2. `src/index.js` -- the export surface.
3. `src/errors.js` -- the typed-failure shape everything uses.
4. `src/ref.js` -- capability generation and the traversal-defense whitelist.
5. `src/stash.js` -- the policy layer.
6. `src/backends/memory.js` -- the backend interface, in its simplest implementation.
7. `test/` -- the shared conformance suite; the SPEC.md section 13 list is the test plan.

This is enough orientation to start contributing without spelunking every module.
