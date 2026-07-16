# Roadmap

`SPEC.md` is the contract; section 12 defines the milestones. This file tracks
their status. One milestone ships at a time, each ending green and committed.

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

## M3 -- Expiry -- NEXT

`expiresAt`, lazy expiry on read, `prune()`, `sweepInterval` (unref'd),
`close()`, `Symbol.asyncDispose`.

## M4 -- Limits

`maxSize` enforced mid-stream, `maxEntries` / `maxTotal`, partial cleanup on
rejection.

## M5 -- Pop & budgets

The claim/stream/commit cycle, `onPopFailure` (`'restore'` default, `'burn'`
opt-in), crash recovery, read budgets on the same claim machinery.

## M6 -- Audit

`has`, `stats`, `verify` (report + opt-in repair), the event set including
`'sweepError'`.

## M7 -- Replication

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
