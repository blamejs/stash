# Roadmap

`SPEC.md` is the contract; section 12 defines the milestones. This file tracks
their status. Each milestone ships green and committed.

## M1 -- Skeleton -- SHIPPED (0.1.0)

`errors.js`, `ref.js` (generation + the whitelist), `duration.js`,
`MemoryBackend`, and `push` / `apply` / `show` / `list` / `drop` / `clear`.
Round-trips a Buffer and a Readable through memory, all errors typed,
traversal refs rejected before any storage access, digest-verified reads.

## M2 -- Disk -- SHIPPED (0.1.1)

`DiskBackend`: sidecar metadata, atomic tmp+fsync+rename writes,
`0700`/`0600` permissions, realpath containment (a planted symlink is
refused, never followed), strict size-bounded sidecar validation, streaming
both directions. The M1 conformance suite passes unmodified against both
backends, and the library suite passes under `--permission` scoped to the
test root.

## M3 -- Expiry -- SHIPPED (0.1.5)

A construct-time `ttl` default, overridable per push (`null` clears it);
`expiresAt` stamped once at push and never extended. Lazy expiry on every read
verb -- an expired entry is `RefNotFound` and dropped in passing, before any
sweep. `list()` filters expired by default (`includeExpired` reveals them);
`prune()` reaps on demand and returns the real destruction count; a
`sweepInterval` arms an `unref()`'d background sweep that never blocks process
exit, skips overlapping ticks, and cannot crash the process on failure.
`close()` (and `Symbol.asyncDispose` for `await using`) stops the timer.

## M4 -- Limits -- SHIPPED (0.1.6)

`maxSize` bounds each entry and is enforced as the bytes stream: the count is
checked before each chunk reaches the backend, so an oversized or unbounded
source aborts with `SizeExceeded` at the limit instead of filling the disk.
`maxEntries` and `maxTotal` bound the whole store; a push that would exceed
either is refused with `StashFull`, and nothing already stored is evicted.
Expired-but-unswept entries are pruned before the store is judged full, so a
dead entry never blocks a live push. Every rejected push leaves no partial
behind. The backend contract gains `stats()` for the aggregate the checks read.

## M5 -- Pop & budgets -- SHIPPED (0.1.7)

`pop(ref)` reads an entry and destroys it the instant the stream drains cleanly;
two concurrent pops race on an atomic claim, so exactly one drains and the other
rejects `RefClaimed`. `push(source, { reads: N })` gives an entry a finite read
budget on the same claim machinery: a credit is spent only on a full,
digest-verified `apply` drain, concurrent budgeted readers serialize so the last
credit is never double-spent, and the read that exhausts the budget destroys the
entry. A read that fails to drain is resolved by `onPopFailure` -- `'restore'`
(default) or `'burn'`. On the disk backend, a claim abandoned by a process
killed mid-pop is reclaimed on the next construction, on the first operation
(`claimTimeout` sets the grace window before a stale claim is resolved); an
interrupted commit is finished, never resurrected, and a drop during a live
claim is monotone. The backend contract gains the claim lifecycle: `claim`,
`restore`, `commit`, `listClaims`, `consumeRead`, `isClaimed`.

## M6 -- Audit -- SHIPPED (0.1.8)

`verify(opts?)` audits physical integrity: it streams a `sha256` over every blob
and reports damage -- `digest-mismatch`, `size-mismatch`, `corrupt-sidecar`,
`missing-blob`, `orphan-blob`, `orphan-tmp`, `foreign-file`, `stale-claim` -- as
`{ scanned, findings, repaired }`. Dry-run by default; `{ repair: true }` removes
only what it condemns, sparing healthy entries, a live push's in-flight `.tmp`,
and a claim recovery owns. Damage is a finding; an I/O fault throws. A `Stash` is
now an `EventEmitter` (`'pushed'` / `'popped'` / `'dropped'` / `'expired'` once
per reaped entry / `'sweepError'`, never `'error'`), with full defensive-copy
Entry payloads emitted after commit, and is async-iterable. `has(ref)` is a
boolean existence check; `stats()` returns `{ entries, bytes, claimed }`. The
backend contract gains `verify`.

## M7 -- Replication -- NEXT

Tombstones on every early-destruction path, `store()` with the SPEC.md
section 4.4 order of checks, `tombstones()`, `tombstoneTtl` pruning.

## M8 -- Docs

README polish, runnable examples (cold-standby sync sketch, the permission
flags), JSDoc across the public surface.

## Standing constraints

Every milestone honors the one rule (no decrypt capability), zero
dependencies, ESM-only, streaming-first, and the do-not-build list (`SPEC.md`
sections 1-3). The constructor refuses options whose milestone has not
shipped -- nothing is ever accepted-but-unenforced.
