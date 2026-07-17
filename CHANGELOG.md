# Changelog

All notable changes to `@blamejs/stash` are documented here, newest first.

## 0.1.11 — 2026-07-17

A correctness sweep of the documentation against the actual code. No library
surface changes. The SPEC.md permission-model command granted read only to
the store directory, so an app launched under --permission could not read its
own module graph and died with ERR_ACCESS_DENIED before the store started; it
now reads the app directory (write still scoped to the store, which is
pre-created). The SPEC.md method table said verify({ repair: true }) removes
what it finds, which overstated it: repair removes damaged blob/sidecar
pairs, orphans, foreign files, and corrupt tombstones, but leaves a stale
claim for crash recovery to resolve. THREAT-MODEL.md and ARCHITECTURE.md
still described the store as mid-build with most milestones unshipped; they
now reflect that the SPEC.md section 12 plan (M1-M8) is complete.
MIGRATING.md's 'no releases have shipped yet' and CONTRIBUTING.md's
milestone-build guidance were likewise brought up to date.

### Fixed

- The `--permission` sandbox command in `SPEC.md` (and the architecture doc
  and generated docs site) was unrunnable: it granted `--allow-fs-read` only
  on the store directory, but Node must read the application's own module
  graph from disk to launch, so the process failed `ERR_ACCESS_DENIED` before
  the store initialized. The command now reads the app directory and writes
  only the pre-created store, matching the shipped `permission-flags`
  example. The accompanying prose is corrected too: the permission model is a
  process-level filesystem allowlist, not per-module isolation.
- `SPEC.md`'s `verify()` description said `{ repair: true }` 'removes what it
  finds'; it now states repair removes damaged blob/sidecar pairs, orphaned
  `.tmp` files, foreign files, and corrupt tombstones, and reports -- but
  never deletes -- a stale claim, which crash recovery owns (deleting a
  restorable claim would be data loss).
- `THREAT-MODEL.md` and `ARCHITECTURE.md` described the store as mid-build
  with milestones M3-M8 'not yet built'; every defense is implemented, and
  both docs now reflect that the `SPEC.md` section 12 delivery plan (M1-M8)
  is complete and the store is feature-complete pre-1.0. The architecture
  module map and backend-interface list are corrected to the full shipped
  set.
- `MIGRATING.md` said 'no releases have shipped yet' (eleven have); it now
  reads 'no breaking-change migrations have shipped yet'. `CONTRIBUTING.md`
  no longer presents the fully-shipped M2-M8 milestones as open build work.

## 0.1.10 — 2026-07-17

This release is documentation; the library surface does not change. Three
runnable examples land under examples/, each a zero-dependency plain-node
script that asserts every step so it cannot rot: lifecycle.js walks an entry
from push through show, apply, pop, read budgets, and expiry; cold-standby.js
replicates a store to a standby with store()/tombstones()/drop() and proves a
stale node cannot resurrect a destroyed entry; permission-flags.js re-execs
itself under the Node permission model and shows a stash write to the granted
root succeeding while a write outside it is denied by the runtime. The README
gains a verb table mapped to the git-stash mental model, an error-code table
generated from src/errors.js so it cannot drift, and a runnable-examples
section. All three examples run in CI, so a broken one fails the build.

### Added

- Runnable examples under `examples/`, each a zero-dependency plain-node
  script that self-asserts: `lifecycle.js` (push -> show -> apply -> pop ->
  gone, read budgets, expiry, prune/clear), `cold-standby.js` (replicate a
  store to a standby and prove no resurrection), and `permission-flags.js`
  (run under `--permission` and prove the filesystem grant is scoped to the
  store root -- an out-of-scope write is denied). All three run in CI and the
  pre-release checks, so a broken example fails the build.
- README verb table mapping every method to the git-stash mental model, and
  an error-code table generated from `src/errors.js` (a drift check keeps it
  in sync with the shipped typed-error set, SPEC.md section 10).

## 0.1.9 — 2026-07-17

store(entry, source) is the replication-grade insert. The caller supplies the
complete Entry -- id, createdAt, expiresAt, reads, readsLeft, digest, meta --
and it lands verbatim, with the bytes verified against the supplied digest
and size as they stream so transfer corruption is caught on the way in and
nothing lands. It proceeds in a fixed order: a malformed id is InvalidRef, a
tombstoned id returns false and writes nothing, an already-expired entry is a
no-op, an identical live entry is an idempotent no-op (retrying a sync is
free), a same-id-different-digest is an IntegrityError, and otherwise it
writes. store() emits no event, so a sync daemon never echoes its own writes.
Every early destruction -- pop, drop, clear, a spent read budget -- now
writes a tombstone of { id, destroyedAt, cause } and nothing that describes
the body; expiry writes none, because an entry's terms travel with it.
tombstones() returns the graves for reconciliation: feed each id to a
replica's drop() and two stores converge with no resurrection. tombstoneTtl
(default '30d', null never prunes) reaps a grave once older than the window,
riding the existing sweep -- with the floor rule the deployment owns: keep it
comfortably above the longest gap between reconciliations.

### Added

- `store(entry, source)` -- the replication-grade insert (a git `stash
  store`). It preserves an existing identity where `push` mints a new one:
  the caller supplies the complete `Entry` and it lands verbatim, honoring
  the REMAINING read budget rather than resetting it. The bytes are verified
  against the supplied `digest` AND `size` as they stream (in-stream, never
  write-then-check), so a transfer that corrupted the bytes throws
  `IntegrityError` and leaves nothing behind. Six checks, in a normative
  order: `1` malformed id -> `InvalidRef` (before any storage access); `2`
  tombstoned id -> `false`, writes nothing; `3` already-expired -> `false`;
  `4` identical live entry (same id, same digest) -> `false` (a retry-based
  sync is free); `5` same id, different digest -> `IntegrityError`
  (corruption, not a merge; the existing entry is untouched); `6` otherwise
  write. The replicated entry is untrusted input -- a shape violation, a
  non-hex digest, an incoherent read budget, or a non-plain `meta` is a typed
  `IntegrityError`, never a partial write. `store` emits NO event, so a sync
  daemon never hears its own writes back.
- Tombstones: every early destruction -- `pop`, `drop`, `clear`, or a read
  that spends the last of a budget -- writes a grave of `{ id, destroyedAt,
  cause }` (cause is `'pop'` / `'drop'` / `'clear'` / `'spent'`) and nothing
  that describes the destroyed entry -- no digest, size, or meta -- so a
  grave can never leak the content the destruction removed. A destroyed id
  never comes back within the tombstone window: `store()` refuses a
  tombstoned id, and two replicas converge because their graves propagate.
  EXPIRY writes no tombstone -- an entry's terms travel with it, and every
  replica reaches the same deadline on its own clock.
- `tombstones()` -> `{ id, destroyedAt, cause }[]` -- the graves, for
  reconciliation. A query: it inspects the shelf, never moves bytes, and is
  loud over a corrupt grave. The done-when it enables: for each grave on one
  store, `drop()` the id on the other; then `store()` each live entry across;
  the two stores converge -- pops don't resurrect, read budgets converge, and
  a repeated `store` is a no-op.
- `tombstoneTtl` constructor option (default `'30d'`; a duration string, a
  number of ms, or `null` to never prune) -- a grave is pruned once older
  than this, riding the existing `prune()` / `sweepInterval` sweep, no second
  timer. The one setting a deployment must get right: it must comfortably
  exceed the longest gap between reconciliations, or a forgotten tombstone
  lets an id come back. StashJS cannot know the sync schedule, so it
  documents this floor rather than enforcing it.
- The `backends/*` storage contract gains `writeTombstone` (first-write-wins
  -- an existing grave is never overwritten, even under concurrent
  destruction of one id), `hasTombstone`, `listTombstones`, and
  `removeTombstone`; both shipped backends implement them, and all four are
  now required backend methods. On disk a grave is one `tombstones/<id>.json`
  sidecar -- atomic, `0600`, realpath-contained, size-bounded before parse,
  and refused if a symlink is planted where it belongs.
- `verify()` now audits grave CONTENTS, not just names: a corrupt tombstone
  (bit rot, tampering, an id that mismatches its filename) is a
  `corrupt-tombstone` finding, and `verify({ repair: true })` removes it --
  so a rotten grave that would otherwise wedge `tombstones()` and `prune()`
  has a recovery path, the same one a corrupt entry sidecar already had.

### Changed

- The `tombstoneTtl` constructor option -- the last spec'd option a shipped
  milestone had not yet implemented -- is now enforced rather than refused.
  Every option `SPEC.md` defines is now accepted and applied; an unknown
  option is still a config-time `TypeError`.

## 0.1.8 — 2026-07-17

verify() walks the store and reports physical damage -- a bit-flipped blob, a
corrupt sidecar, a size mismatch, an orphaned blob or half-written .tmp, a
foreign file, a stale claim -- digest-checking every blob as a stream. It is
a dry run by default; verify({ repair: true }) removes only what it condemns,
sparing healthy entries, a live push's in-flight .tmp, and a claim recovery
still owns. A Stash is now an EventEmitter: 'pushed' when a push commits,
'popped' when a pop's delete lands, 'dropped' on drop / clear / a spent read
budget, 'expired' exactly once per reaped entry, and 'sweepError' -- never
'error' -- when a background sweep throws, so a janitor can never crash the
app. has(ref) is a boolean existence check, stats() returns { entries, bytes,
claimed }, and a Stash is async-iterable.

### Added

- `verify(opts?)` audits the store's physical integrity. Dry-run by default:
  it streams a `sha256` over every blob and reports damage --
  `digest-mismatch`, `size-mismatch`, `corrupt-sidecar`, `missing-blob`,
  `orphan-blob`, `orphan-tmp`, `foreign-file`, `stale-claim` -- as `{
  scanned, findings: [{ kind, id }], repaired: [] }`, touching nothing. `{
  repair: true }` removes ONLY what it condemns (a damaged entry's blob and
  sidecar together); a healthy entry survives byte-identical, a live push's
  in-flight `.tmp` is spared, and a stale claim is reported but never deleted
  (resolving it is crash recovery's job). Damage is a finding; an I/O fault
  (a permission denial, a vanished layout dir) throws rather than resolving a
  falsely clean report. Finding `id`s are refs; a foreign or `.tmp` name
  reports `id: null`, so verify never echoes an on-disk path.
- A `Stash` is now an `EventEmitter` (`node:events`). It emits `'pushed'`
  (Entry) after a push commits, `'popped'` (Entry) after a pop's delete
  lands, `'dropped'` (Entry) on `drop`, `clear`, or a budget-exhausting read,
  `'expired'` (Entry) exactly once per reaped entry (whichever of the lazy
  read path or the sweeper wins), and `'sweepError'` (Error) when a
  background sweep throws. The failure channel is `'sweepError'`, NEVER
  `'error'` -- an unhandled `'error'` crashes a Node process, and a
  background janitor must not be able to take the app down; with no listener
  it is a no-op. Every payload is a full, defensive-copy Entry emitted after
  the state change commits, so a throwing listener cannot unwind the
  committed operation.
- `has(ref)` is an existence check without the try/catch `show` needs: `true`
  for a live entry, `false` for an unknown or expired ref (reaped in
  passing), `InvalidRef` for a malformed ref before any backend access, and
  `IntegrityError` for a corrupt entry rather than a `false` that would hide
  corruption.
- `stats()` returns `{ entries, bytes, claimed }` -- aggregate counts, never
  refs -- over a fast physical walk; an expired-but-unswept entry still
  counts until a read or `prune()` reaps it, and a foreign file in the layout
  fails the count loudly.
- A `Stash` is async-iterable: `for await (const entry of stash)` yields the
  live entries, sugar over `list()`.
- The `backends/*` storage contract gains `verify(opts)`; both shipped
  backends implement it, and it is now a required backend method.

### Changed

- `drop(ref)` on an expired entry now returns `false` and emits `'expired'`
  (not `'dropped'`): an expired entry is already nonexistent on every public
  surface, so dropping one reaps it rather than reporting a live removal.
  `clear()` likewise counts only the live entries it destroys.
- The disk backend's `remove` deletes the sidecar with `unlink` rather than
  `rm`, so the boolean it returns is a true single-writer witness -- exactly
  one of two concurrent reapers reports the removal, which is what makes an
  `'expired'`/`'dropped'` event fire exactly once under a lazy-read / sweep
  race.

## 0.1.7 — 2026-07-16

pop(ref) streams an entry and deletes it the instant the stream drains
cleanly -- bytes out once, then gone -- with two concurrent pops racing on an
atomic claim so exactly one drains and the other is refused. push(source, {
reads: N }) gives an entry a finite read budget: a credit is spent only on a
full, digest-verified drain, and the read that exhausts it destroys the
entry, with concurrent budgeted readers serialized so the last credit can
never be double-spent. A read that fails or is abandoned costs nothing and is
resolved by onPopFailure -- restored for a retry by default, or burned. On
the disk backend, a claim abandoned by a process killed mid-pop is reclaimed
on the next construction rather than stranding the entry, and destruction
stays monotone across the crash: a dropped entry never comes back.

### Added

- `pop(ref)` reads an entry's bytes and destroys it: the stream is
  digest-verified as it drains, and the entry is deleted the instant it
  drains cleanly -- bytes out once, then gone. Two concurrent `pop(ref)` race
  on an atomic claim: exactly one wins and drains, the other rejects
  `RefClaimed` (code `ECLAIMED`). `pop` ignores any read budget -- it is
  terminal by definition.
- `push(source, { reads: N })` gives an entry a read budget: a positive
  integer count of successful `apply` drains after which the entry
  self-destructs (`null`, the default, is unlimited). A budgeted `apply`
  spends one credit only on a full, digest-verified drain -- an abandoned or
  corrupted read costs nothing -- concurrent budgeted readers serialize
  through the claim so the last credit can never be double-spent, and the
  read that takes the budget to zero destroys the entry through the same path
  as `pop`. An unbudgeted `apply` stays lock-free and pays nothing for the
  feature.
- `onPopFailure` (constructor option) decides what happens to an entry whose
  `pop` or budgeted `apply` fails to fully drain -- a stream destroyed early,
  a source error, a digest mismatch: `'restore'` (the default) returns the
  entry so the read can be retried, `'burn'` destroys it anyway.
- Crash recovery (disk backend): a claim left behind by a process killed
  mid-`pop` is reclaimed on the next construction, on the first operation --
  never in the constructor, which does no I/O. `claimTimeout` (constructor
  option, default `'10m'`) is how long such a claim is treated as another
  live reader's before recovery resolves it per `onPopFailure`; a younger
  claim is left untouched. A claim whose entry was already deleted is
  completed -- the interrupted deletion finishes -- never resurrected, and a
  drop during a live claim destroys the entry for good: an abandoned read
  cannot bring it back.
- The `backends/*` storage contract gains `claim`, `restore`, `commit`,
  `listClaims`, `consumeRead`, and `isClaimed` -- the claim lifecycle the pop
  and budget paths drive. Both shipped backends implement them, and they are
  now required backend methods.

### Changed

- `onPopFailure` and `claimTimeout` are now live constructor options; they
  previously threw at construction as not-yet-shipped. `onPopFailure` must be
  `'restore'` or `'burn'`, and `claimTimeout` a POSITIVE duration -- a
  non-positive lease would let recovery reclaim an active pop instantly, so
  it is a config-time `TypeError`. Recovery reclaims a claim by age alone, so
  a disk root is single-writer and `claimTimeout` must exceed the longest
  read a deployment runs.
- A custom backend must now implement the claim lifecycle -- `claim`,
  `restore`, `commit`, `listClaims`, `consumeRead`, and `isClaimed` --
  alongside the existing methods, or the `Stash` constructor rejects it.

## 0.1.6 — 2026-07-16

A store can now be bounded. maxSize caps each entry and is enforced as the
bytes stream, so an oversized or unbounded source is cut off at the limit
rather than written and then measured. maxEntries and maxTotal bound the
whole store; a push that would exceed either is refused with StashFull, and
nothing already stored is evicted to make room. Expired-but-unswept entries
are reaped before the store is judged full, so a dead entry never blocks a
live push. Every rejected push leaves nothing behind.

### Added

- `maxSize` (constructor option) bounds each entry -- a size string like
  `'100mb'` or a byte count. It is enforced during the write stream: the
  running byte count is checked before each chunk is handed to the backend,
  so a push that crosses the limit aborts with `SizeExceeded` (code `E2BIG`)
  and an unbounded or hostile source is cut off at the boundary instead of
  filling the disk. Every chunk is counted by its real byte length -- a
  multibyte string by its encoded size, a typed array or ArrayBuffer by its
  byte count rather than its element count -- so no chunk shape slips past
  the limit, and each is stored by its exact bytes.
- `maxEntries` and `maxTotal` (constructor options) bound the whole store. A
  push that would exceed the entry count or the total byte size is refused
  with `StashFull` (code `EFULL`), and no existing entry is evicted to make
  room -- a flood of pushes cannot delete other people's data. `maxEntries`
  is checked before the stream starts; `maxTotal` is enforced against the
  remaining headroom as the bytes stream.
- `maxTotal` counts the stored footprint -- each blob plus the metadata
  stored beside it -- not the blob bytes alone. The entry's own metadata is
  charged against the headroom before the blob streams, so a caller cannot
  slip past the limit with a flood of tiny (or zero-byte) blobs carrying
  large `meta`.
- Expired-but-unswept entries are pruned before the store is judged full, so
  an entry past its deadline that no read or sweep has reaped yet never
  blocks a live push against `maxEntries` or `maxTotal`.
- The `backends/*` storage contract gains `stats()` -> `{ entries, bytes,
  claimed }`, the aggregate the limit checks read instead of parsing every
  entry. Both shipped backends implement it, and it is now a required backend
  method.

### Changed

- A malformed limit value fails at construction: `maxSize` / `maxTotal` must
  be a positive size, and `maxEntries` a positive integer count -- zero, a
  negative, a fraction, or a non-size string is a config-time `TypeError`,
  never a silently disabled check.
- A `maxSize` larger than `maxTotal` is refused at construction: a per-entry
  cap above the whole-store cap can never bind, since even an empty store
  admits at most `maxTotal` bytes. The contradiction surfaces as a
  `TypeError` at boot rather than as dead configuration.
- Because the store's size is read but not locked, concurrent pushes can
  overshoot a stash-wide bound by the number in flight; the bound stops
  unbounded growth rather than pinning the store to an exact byte. A custom
  backend must now provide `stats()`.

## 0.1.5 — 2026-07-16

Push an entry with a TTL and it reads back as gone once the deadline passes
-- lazily on the next read, before any sweep has run, and optionally on a
background timer that never holds your process open. A construct-time default
applies to every push and is overridable per call; expiry is fixed at push
and only ever moves an entry toward destruction, never further. prune() reaps
on demand, list() hides expired entries by default, and close() (or await
using) stops the sweeper.

### Added

- A construct-time `ttl` default -- `'30m'`, `'24h'`, `'7d'`, a number of
  milliseconds, or `null` for no expiry -- applied to every push and
  overridable per call with `push(source, { ttl })`. An explicit `ttl: null`
  on a push clears a construct-time default back to no expiry; an absent
  option inherits it. A ttl whose deadline would exceed the safe integer
  range is refused at config time rather than serialized as a false 'never
  expires'.
- Lazy expiry on every read: `apply` and `show` treat an expired entry as
  `RefNotFound` and drop it in passing, so an expired entry is never served
  even if the sweeper has not run. `list()` filters expired entries out by
  default; `list({ includeExpired: true })` includes them, and `list` only
  filters -- it never drops.
- `prune()` destroys expired entries on demand and resolves to the count
  actually destroyed (an entry a concurrent drop removes first is not
  double-counted).
- `sweepInterval` arms a background `prune()` on a timer that is
  `.unref()`'d, so an open `Stash` never holds the process open on exit; it
  skips overlapping sweeps and cannot crash the process if a sweep fails. A
  `sweepInterval` above Node's timer ceiling, or of zero, is a config-time
  error rather than a silent busy loop.
- `close()` stops the sweep timer and is idempotent; `Symbol.asyncDispose`
  aliases it, so `await using stash = new Stash(...)` clears the timer when
  the block exits, even on throw.

### Changed

- `apply` and `show` may now delete: reaping an expired entry in passing
  calls the backend's remove. Under `--permission`, the read verbs therefore
  need the same write grant on the stash root the rest of the store already
  uses; a denied delete surfaces loudly rather than degrading into a silent
  not-found.

## 0.1.4 — 2026-07-16

The disk backend closes a family of filesystem-race and denial-of-service
vectors: reads bind to a verified descriptor, the containment check moves to
the moment of the write, and a planted named pipe can no longer hang a read.
The memory backend copies caller-owned bytes, and the documentation site now
ships as a hardened container alongside a continuous fuzzing harness over the
store's untrusted-input surfaces.

### Added

- The documentation site ships as a stateless, hardened container (nonroot,
  all capabilities dropped) with a single-container local deploy and a
  production overlay that fronts it with automatic TLS; a runbook covers
  both.
- Continuous fuzzing of the store's untrusted-input surfaces -- the
  capability-ref validator and the sidecar-metadata parser -- runs on every
  pull request and on a schedule.

### Fixed

- DiskBackend reads a blob or sidecar through a descriptor whose identity is
  verified against the name it was opened through, so a symlink or file
  swapped in after the check can no longer redirect the read outside the
  storage root (CWE-367). On platforms without O_NOFOLLOW the descriptor's
  device and inode are checked against a no-follow lookup of the name,
  closing the swap window there too.
- A blob or sidecar replaced with a named pipe can no longer hang a read:
  stored files open non-blocking, so a pipe with no writer is refused as
  corruption instead of parking show, list, or apply forever (CWE-410).
- DiskBackend re-checks storage-root containment at the moment it writes the
  sidecar rather than before streaming the blob, so a directory swapped in
  during a long write can no longer land metadata outside the root.
- The sidecar's stored identity is compared to the addressed identity in
  constant time, matching the timing-safe comparison the rest of the store
  already uses (CWE-208).
- MemoryBackend copies each caller-owned chunk it retains, so a caller that
  reuses its buffer after yielding no longer corrupts the stored bytes.
- A push whose sidecar write fails now cleans up the blob on every path,
  including the final rename, leaving no orphaned bytes behind.

## 0.1.3 — 2026-07-16

Every documented primitive now names the external standards it implements and
the weakness classes it defends, and the npm publish pipeline ships its first
working end-to-end run.

### Added

- Conformance tags across the documented surface: primitives cite the
  standards they implement (FIPS 180-4 digests, RFC 4648 base64url refs, RFC
  8259 sidecar JSON) alongside their SPEC.md sections, and name the CWE
  classes they defend (CWE-22/23 path traversal at the ref whitelist, CWE-59
  link following at the containment check, CWE-208 timing at the
  constant-time compare, CWE-330/340 ref predictability, CWE-354 silent
  corruption, CWE-377 temp-file exposure, CWE-770 sidecar allocation bounds,
  CWE-209/532 capability leakage, CWE-1188 refused-not-ignored options). The
  documentation site renders both on every primitive.
- THREAT-MODEL.md maps each threat class to its CWE identifiers.

### Changed

- ARCHITECTURE.md and THREAT-MODEL.md implementation statuses reflect the
  shipped disk backend.

### Fixed

- The publish workflow extracts release notes with the changelog's actual
  header grammar (the previous matcher expected a v-prefixed header with an
  ASCII suffix and could never match the generated file).
- An explicit workflow dispatch may publish when the built commit is exactly
  the commit the version's pushed tag points at -- a fix to the publish path
  itself can now ship a release without minting a new tag for it, while a
  dispatch can never publish bytes no tag vouches for.

## 0.1.2 — 2026-07-16

The documentation site's accent surfaces move to the logo's own measured blue
family, the README fronts the logo, and two continuous-integration gates are
hardened.

### Changed

- Documentation site: links, active navigation, focus borders, badges, search
  highlights, code inks, the hero glow, and the browser theme color now come
  from the logo's measured blue ramp; syntax-highlighting keyword and
  operator tokens are re-inked to match through site-owned overrides (the
  vendored highlighter file is untouched). Every introduced color pair is
  contrast-checked; one pre-existing text-contrast failure is fixed,
  unfocused search fields gain a visible boundary, keyboard-selected search
  results are conveyed by color rather than background alone, and printed
  pages force code and highlights to legible ink on white.
- README: the logo now heads the page, served from assets/.
- Documentation server: the default port moves to 3011 (WIKI_PORT still
  overrides).
- actions/setup-node moves to the v7.0.0 pin; the diff between the pinned
  commits was reviewed (two new cache outputs, toolchain migration, no new
  execution surface).

### Fixed

- The forbidden-token gates in both CI workflows now fail on a hit in ANY
  pattern: under errexit a non-final negated command's failure was silently
  skipped, which left the first pattern advisory.
- The CI checkout no longer persists credentials into the workspace.

## 0.1.1 — 2026-07-15

The M2 milestone: `DiskBackend` (`@blamejs/stash/backends/disk`) brings
persistent storage under the same contract the memory backend implements --
the whole conformance suite runs against both, unmodified.

### Added

- `DiskBackend`: one blob plus one JSON sidecar per entry (`blobs/<id>`,
  `meta/<id>.json`), no central index to corrupt -- a listing is a readdir
  plus sidecar reads. Directories are created `0700` and files `0600`, lazily
  on first use; the constructor does no I/O.
- Atomic writes: bytes stream to `blobs/<id>.tmp` with size and `sha256`
  digest computed as they pass, then fsync and rename -- a reader never sees
  a partial blob, and a failed push leaves nothing behind.
- Realpath containment: the root is pinned at first use and every operation
  re-asserts that its directory still resolves inside it. A subdirectory
  swapped for a link out of the root is refused with `InvalidRef`; a symlink
  where a blob should be is refused as `IntegrityError`, never followed. The
  Node permission model follows symlinks out of granted paths, so this check
  is the store's own wall.
- Strict sidecar validation: a sidecar is size-bounded before it is read,
  parsed under a corruption verdict, and shape-checked field by field against
  the one canonical Entry structure -- wrong types, missing or extra fields,
  an identity mismatch, or a malformed digest are `IntegrityError`, and
  `list()` fails loud over a corrupt sidecar rather than silently skipping
  it. Entries carrying valid future terms (an expiry, a read budget) are
  accepted, so a store written by a newer release stays readable.
- A crash mid-write leaves an invisible orphan, never a served half-entry: a
  blob without its sidecar does not exist to `list`/`show`/`apply`, and a
  sidecar whose blob is missing is a loud `IntegrityError`.

### Changed

- The documentation site's Backends page now covers the storage contract and
  both shipped backends.

## 0.1.0 — 2026-07-15

Initial release: the M1 surface of the specification.

### Added

- `Stash` with `push` / `apply` / `show` / `list` / `drop` / `clear` over a
  backend, plus the `MemoryBackend` (`@blamejs/stash/backends/memory`).
- Refs as capabilities: `v1_` + 32 random bytes (base64url), validated
  against a strict whitelist before any storage access -- ref validation is
  the path-traversal defense.
- Digest-verified reads: `apply` streams through a `sha256` check and errors
  with `IntegrityError` instead of delivering silently corrupted bytes.
- The typed error set with frozen codes: `RefNotFound` (`ENOREF`),
  `RefClaimed` (`ECLAIMED`), `IntegrityError` (`EINTEGRITY`), `SizeExceeded`
  (`E2BIG`), `StashFull` (`EFULL`), `InvalidRef` (`EBADREF`), all extending
  `StashError`. No error message contains a ref, a `meta` value, or a path.
- Fail-loud configuration: spec options whose milestone has not shipped
  (`ttl`, `maxSize`, `maxEntries`, `maxTotal`, `onPopFailure`,
  `tombstoneTtl`, `sweepInterval`, `claimTimeout`, per-push `ttl`/`reads`)
  throw a `TypeError` at the call site instead of being accepted and ignored.
- The source-generated documentation site under `examples/wiki`.
