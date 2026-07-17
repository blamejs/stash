<div align="center">

<img src="assets/stashjs-logo.png" alt="@blamejs/stash" width="200" />

# @blamejs/stash

**A zero-dependency, ephemeral, crypto-agnostic content store for Node.js.**

Bytes in, a random-capability ref out, bytes out once and they're gone. No key
lives anywhere in the store, so no operator can be compelled to use one. No npm
runtime dependencies. No TypeScript. No build step.

[![npm version](https://img.shields.io/npm/v/@blamejs/stash.svg?label=%40blamejs%2Fstash&color=2563eb)](https://www.npmjs.com/package/@blamejs/stash)
[![npm downloads](https://img.shields.io/npm/dm/@blamejs/stash.svg?color=2563eb)](https://www.npmjs.com/package/@blamejs/stash)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![node](https://img.shields.io/node/v/@blamejs/stash.svg)](https://nodejs.org)

[![CI](https://github.com/blamejs/stash/actions/workflows/ci.yml/badge.svg)](https://github.com/blamejs/stash/actions/workflows/ci.yml)
[![CodeQL](https://github.com/blamejs/stash/actions/workflows/codeql.yml/badge.svg)](https://github.com/blamejs/stash/actions/workflows/codeql.yml)
[![Fuzzing](https://github.com/blamejs/stash/actions/workflows/cflite_batch.yml/badge.svg)](https://github.com/blamejs/stash/actions/workflows/cflite_batch.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/blamejs/stash/badge)](https://scorecard.dev/viewer/?uri=github.com/blamejs/stash)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13632/badge)](https://www.bestpractices.dev/projects/13632)
[![SLSA 3](https://slsa.dev/images/gh-badge-level3.svg)](https://slsa.dev/spec/v1.0/levels#build-l3)

[![Zero runtime deps](https://img.shields.io/badge/runtime%20deps-0-2ea043)](#why-this-store)
[![No keys](https://img.shields.io/badge/keys-none%20by%20design-2563eb)](#why-this-store)
[![No TypeScript](https://img.shields.io/badge/TypeScript-not%20required-2ea043)](#why-this-store)
[![Fail-closed](https://img.shields.io/badge/verdicts-fail--closed-2ea043)](#why-this-store)

[stashjs.com](https://stashjs.com) · [Roadmap](ROADMAP.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

</div>

You put bytes in. You get a ref back. You take the bytes out once, and they're
gone.

```js
import { Stash } from "@blamejs/stash";
import { MemoryBackend } from "@blamejs/stash/backends/memory";

const stash = new Stash({ backend: new MemoryBackend() });

const ref = await stash.push(ciphertext, { meta: { kind: "drop" } });
// 'v1_...' -- 256 bits of random capability, never a content hash

const readable = await stash.apply(ref);   // digest-verified stream
await stash.drop(ref);                     // gone
```

## Why this store

- **It can't decrypt anything.** No method takes a key; no cipher primitive is
  imported anywhere in the tree, and CI proves it on every commit. A store
  that *chooses* not to decrypt is a promise; a store with nowhere for a key
  to live is an architecture. Encryption belongs to the layer above.
- **Refs are capabilities, not addresses.** `v1_` + 32 random bytes,
  unguessable, never derived from content -- so holding a suspect document
  never lets anyone probe whether it is stored. Ref validation is a strict
  whitelist that doubles as path-traversal defense.
- **Write-once, monotone lifecycle.** Every state change moves an entry closer
  to destruction -- read budgets only decrement, expiry only arrives, and
  nothing can argue an entry back from the brink. There is no `touch()`.
- **Fail-closed verdicts.** Every failure is a typed `StashError` with a
  frozen `.code`; no path returns a default in place of an answer, and no
  error message ever contains a ref, a `meta` value, or a path.
- **Zero dependencies.** Runtime *and* development. Node builtins only, ESM,
  no build step. `npm install @blamejs/stash` adds exactly one package.

## Install

```
npm install @blamejs/stash
```

Requires Node `>= 24.18.0`.

## What ships today

The M1 + M2 + M3 + M4 + M5 + M6 + M7 surface (see `SPEC.md` section 12 for the full delivery plan):

- `push` / `pop` / `apply` / `show` / `has` / `list` / `stats` / `verify` /
  `store` / `tombstones` / `drop` / `clear` over either backend, with size and
  `sha256` digest computed as the bytes stream through and digest-verified reads.
- **Pop & read budgets**: `pop(ref)` streams an entry and destroys it the
  instant the stream drains cleanly -- bytes out once, then gone -- with two
  concurrent pops racing on an atomic claim so exactly one drains and the other
  rejects `RefClaimed`. `push(source, { reads: N })` gives an entry a finite
  read budget: a credit is spent only on a full, digest-verified `apply` drain
  (an abandoned or corrupted read costs nothing), concurrent budgeted readers
  serialize so the last credit is never double-spent, and the read that
  exhausts the budget destroys the entry. A read that fails to drain is resolved
  by `onPopFailure` -- `'restore'`d for a retry by default, or `'burn'`ed. On
  the disk backend, a claim abandoned by a process killed mid-pop is reclaimed
  on the next construction (`claimTimeout` sets the grace window), and a drop
  during a live claim is monotone -- the entry never comes back.
- **Limits**: `maxSize` bounds each entry and is checked as the bytes stream, so
  an oversized or unbounded source aborts with `SizeExceeded` at the limit
  rather than filling the disk; `maxEntries` and `maxTotal` bound the whole
  store and refuse an over-budget push with `StashFull` without evicting
  anything already stored. Expired-but-unswept entries are reaped before the
  store is judged full, and every rejected push leaves no partial behind.
- **Audit & events**: `verify()` walks the store and reports physical damage --
  a bit-flipped blob, a corrupt sidecar, an orphaned blob or half-written
  `.tmp`, a foreign file, a stale claim, a corrupt tombstone -- streaming a `sha256` over every blob;
  it is a dry run by default, and `verify({ repair: true })` removes only what it
  condemns, sparing healthy entries, an in-flight `.tmp`, and a claim recovery
  owns. A `Stash` is an `EventEmitter` -- `'pushed'` / `'popped'` / `'dropped'` /
  `'expired'` (exactly once per reaped entry) / `'sweepError'` (never the
  process-killing `'error'`) -- and is async-iterable. `has(ref)` is a boolean
  existence check; `stats()` returns `{ entries, bytes, claimed }`.
- **Expiry**: a construct-time `ttl` default (`'24h'`, `'7d'`, ms, or `null`),
  overridable per `push`. An expired entry reads back as `RefNotFound` and is
  dropped in passing, before any sweep. `list()` hides expired entries by
  default (`{ includeExpired: true }` reveals them); `prune()` reaps on demand;
  `sweepInterval` arms an `unref()`'d background sweep that never holds the
  process open. `close()` -- or `await using` via `Symbol.asyncDispose` --
  stops it. Terms are fixed at push and only ever move an entry toward
  destruction; there is no touch or extend.
- **The disk backend** (`@blamejs/stash/backends/disk`): one blob + one JSON
  sidecar per entry, no central index to corrupt, atomic
  tmp-fsync-rename writes, `0700`/`0600` modes, realpath containment that
  refuses planted symlinks instead of following them, and strict
  size-bounded sidecar validation -- corruption is a typed `IntegrityError`,
  never silently bad bytes and never a silent skip.
- The in-memory backend, same contract, for tests and process-lifetime
  stashes. One conformance suite runs against both, unmodified.
- The full typed error set (`RefNotFound`, `RefClaimed`, `IntegrityError`,
  `SizeExceeded`, `StashFull`, `InvalidRef` -- all `StashError`, all with
  frozen codes).
- Ref generation and whitelist validation.

- **Replication**: `store(entry, source)` files an already-created entry with its
  identity intact -- the caller supplies the full `Entry` and it lands verbatim,
  the bytes verified against the supplied digest and size as they stream so
  transfer corruption is caught on the way in. A malformed id, a tombstoned id, an
  already-expired entry, or a digest conflict is refused before anything lands; an
  identical entry is an idempotent no-op, so retrying a sync is free. A replicated
  entry honors the stash limits like a push -- one larger than `maxSize`, or past
  `maxEntries` / `maxTotal`, is refused rather than slipping the capacity -- and two
  concurrent stores of the same id are serialized so conflicting replicas can't both land. `store` emits
  no event, so a sync daemon never echoes its own writes. Every early destruction --
  `pop`, `drop`, `clear`, a spent read budget -- leaves a tombstone of
  `{ id, destroyedAt, cause }` (expiry leaves none); `tombstones()` returns them for
  reconciliation, and feeding each id to a replica's `drop()` converges two stores
  with no resurrection. `tombstoneTtl` (default `'30d'`, `null` never prunes) reaps
  a grave once older than the window -- keep it above the longest gap between
  reconciliations, or a forgotten grave lets an id come back.

Every option `SPEC.md` defines is now accepted and enforced; an unknown option is a
config-time `TypeError`.

The `SPEC.md` section 12 delivery plan is complete; the store is feature-complete
pre-1.0. `SPEC.md` is the contract.

## The verbs

The moving verbs are `git stash`'s, with the same mental model; the rest are
queries and janitorial work. Every verb runs against either backend, unmodified.

| Verb | Does | Destroys? |
|---|---|---|
| `push(source, opts?)` | Store bytes; mint a random-capability ref. | no |
| `store(entry, source)` | File an already-created entry, identity preserved (replication). | no |
| `apply(ref)` | Stream an entry, digest-verified; a read budget spends one credit. | only on the budget-exhausting read |
| `pop(ref)` | Stream an entry, then destroy it the instant it drains cleanly. | yes |
| `show(ref)` | Resolve a ref to its metadata (never the bytes). | no |
| `has(ref)` | Boolean existence check. | no |
| `list(opts?)` | Every live entry's metadata (expired hidden by default). | no |
| `stats()` | `{ entries, bytes, claimed }` for the whole store. | no |
| `tombstones()` | The graves `{ id, destroyedAt, cause }`, for reconciliation. | no |
| `verify(opts?)` | Audit physical integrity; `{ repair: true }` removes only what it condemns. | only under `repair` |
| `drop(ref)` | Delete an entry (and tombstone the id). | yes |
| `clear()` | Drop everything; return the count. | yes |
| `prune()` | Reap expired entries on demand. | yes (expired only) |
| `close()` | Stop the background sweep (also `await using`). | no |

## Error codes

Every OPERATIONAL failure -- a bad ref, a missing entry, a corrupt blob, a full
store -- is a typed `StashError` with a frozen `.code`: branch on the code, never
the message (messages improve between patches; codes do not, `SPEC.md` section 10),
and no message ever contains a ref, a `meta` value, or a path. Configuration
mistakes are separate: an unknown option or a source that isn't a supported type
throws a native `TypeError` at the call, before any storage is touched.

<!-- BEGIN error-codes (generated from src/errors.js by scripts/regen-readme.js) -->

| Code | Class | Raised when |
|---|---|---|
| `ENOREF` | `RefNotFound` | Unknown or expired ref. |
| `ECLAIMED` | `RefClaimed` | A concurrent pop already claimed the entry. |
| `EINTEGRITY` | `IntegrityError` | Blob bytes no longer match the recorded digest. |
| `E2BIG` | `SizeExceeded` | maxSize crossed mid-stream. |
| `EFULL` | `StashFull` | maxEntries / maxTotal reached; the push was refused. |
| `EBADREF` | `InvalidRef` | Malformed ref string; refused before any storage access. |

<!-- END error-codes -->

## Runnable examples

Each is a plain-node script, zero dependencies, runnable straight from a clone:

```
node examples/lifecycle.js         # push -> show -> apply -> pop -> gone; budgets; expiry
node examples/cold-standby.js      # replicate a store without resurrecting the dead
node examples/permission-flags.js  # run under --permission; prove the grant is scoped
```

They assert every step and run in CI, so a broken example fails the build.

## Run it sandboxed

StashJS is designed to run under the Node permission model, with the WRITE grant
scoped to the store. The read grant spans the app directory -- Node loads its
module graph (your code and `node_modules`) from disk -- while only the store's
directory is writable. Create that directory first: under the sandbox the backend
can fill it but not create it (creating it would need write on its parent).

```
mkdir -p .stash
node --permission --allow-fs-read=. --allow-fs-write=./.stash app.js
```

The Node permission model is a process-level filesystem allowlist, not per-module
isolation: it confines the whole process -- StashJS and every dependency loaded
alongside it -- to the granted paths, so a compromised dependency cannot reach
the wider filesystem (your keys, other apps' data), only the stash root and the
app's own source. Code sharing the process can still read the stash root; run the
stash in its own process to isolate it from other code in the tree. (On Node 24.x
`--permission` does not gate the network; StashJS opens no sockets regardless.)
The store never spawns child processes, never starts worker threads, and never
accepts a file descriptor as input, so no wider grant is ever needed.

## Documentation

- `SPEC.md` -- the full specification: API, semantics, threat reasoning, and
  the do-not-build list.
- `ARCHITECTURE.md` -- the policy/backend split and the design invariants.
- `THREAT-MODEL.md` -- what the store defends against, and what it refuses to
  pretend to defend against.
- `examples/wiki` -- the documentation site, generated from the source's own
  comment blocks (`npm run wiki:e2e` proves it; `node examples/wiki/server.js`
  serves it).

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
