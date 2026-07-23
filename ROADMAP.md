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

`verify(opts?)` audits physical integrity: it re-hashes every blob with the
entry's own algorithm and reports damage -- `digest-mismatch`, `size-mismatch`, `corrupt-sidecar`,
`missing-blob`, `orphan-blob`, `orphan-tmp`, `foreign-file`, `stale-claim` -- as
`{ scanned, findings, repaired }`. Dry-run by default; `{ repair: true }` removes
only what it condemns, sparing healthy entries, a live push's in-flight `.tmp`,
and a claim recovery owns. Damage is a finding; an I/O fault throws. A `Stash` is
now an `EventEmitter` (`'pushed'` / `'popped'` / `'dropped'` / `'expired'` once
per reaped entry / `'sweepError'`, never `'error'`), with full defensive-copy
Entry payloads emitted after commit, and is async-iterable. `has(ref)` is a
boolean existence check; `stats()` returns `{ entries, bytes, claimed }`. The
backend contract gains `verify`.

## M7 -- Replication -- SHIPPED (0.1.9)

Every early destruction -- `pop`, `drop`, `clear`, a spent read budget -- writes a
tombstone of `{ id, destroyedAt, cause }` and nothing more, so a destroyed id never
comes back; expiry writes none (terms travel with the entry). `store(entry, source)`
is the replication-grade insert: it files an already-created entry with its identity
preserved, proceeds through the section 4.4 order of checks (malformed id, tombstoned
id, expired, identical, digest conflict, else write), verifies the bytes against the
supplied digest and size as they stream, and emits nothing -- a sync daemon never
hears its own writes. `tombstones()` returns the graves for reconciliation; feeding
each id to a replica's `drop()` converges two stores with no resurrection.
`tombstoneTtl` (default `'30d'`, `null` never prunes) reaps a grave once older than
the window, riding the existing sweep. The backend contract gains `writeTombstone`,
`hasTombstone`, `listTombstones`, and `removeTombstone`.

## M8 -- Docs -- SHIPPED (0.1.10)

Three runnable, self-asserting examples under `examples/` -- a lifecycle
walkthrough, a cold-standby replication sketch, and a permission-model grant
demonstration that re-execs itself under `--permission` and proves an
out-of-scope write is denied -- all run in CI, so a broken example fails the
build. The README
gains a verb table mapped to the git-stash mental model and an error-code table
generated from `src/errors.js` (a drift check keeps it in sync). The public
surface is documented in full through the source comment blocks the wiki
renders. No library surface changes -- the `SPEC.md` section 12 delivery plan is
complete.

## M9 -- Digest agility -- SHIPPED (0.1.12)

The integrity hash becomes a construct-time choice. `new Stash({ backend, digest })`
selects `sha256` (the default, unchanged), `sha512`, `sha3-256`, `sha3-512`, or
`shake256` -- all `node:crypto` builtins, so the zero-dependency rule holds, and
still no key and no cipher: this is integrity, not confidentiality. The stored
digest is self-describing (`"algo:hex"`), so `apply`, `pop`, and `verify()` hash
each entry with its OWN algorithm and one store may mix them; `store()` replicates
an entry with its algorithm intact. Omitting the option keeps `sha256`, so every
existing store is byte-identical. This extends the `SPEC.md` section 12 plan beyond
its original close.

## Hardening -- disk file identity -- SHIPPED (0.1.13)

On a filesystem without `O_NOFOLLOW` (Windows), the disk backend cross-checks an
open descriptor's identity against a no-follow lookup of the name to catch a
symlink traversed at open or a name swapped after it. That check keyed on device
+ inode alone; Windows can transiently report inode `0` for a file under heavy
parallel I/O, so two distinct files could be mistaken for one -- a fail-open in
the swap guard. The identity comparison now also requires size and creation time
to agree; the terms are ANDed, so the check is strictly more selective and an
untampered read still matches. It is the single choke point behind both the
read-path swap guard and the crash-recovery interrupted-claim check.

## Operational CLI -- SHIPPED (0.1.14)

The store gains its first executable entry point: the `stashjs` command
(`npx @blamejs/stash <command>`) inspects and maintains a disk-backed stash from
the shell -- `verify` (`--repair`), `stats`, `prune`, `list` (`--include-expired`),
`tombstones`, and `has <ref>` -- with a human table by default and `--json` for
scripting. It composes only the already-shipped query and maintenance verbs: it
never moves bytes and never destroys by ref, so it hands out no capability and
streams no blob. The root is taken from `--root`, `$STASH_ROOT`, or `./.stash` and
must already exist. It fails closed with stable exit codes, keeps every error
capability-free, and runs under `--permission` exactly as the library. Being a
second process on a disk root, it is single-writer: point it at a quiesced store or
a cold-standby replica.

## Replication and recovery hardening -- SHIPPED (0.1.15)

`reconcilable()` is a resilient anti-entropy source read: it returns the healthy
entries to replicate plus the ids of entries whose sidecars are too damaged to
read, so one corrupt entry no longer halts the sync of every sound one, while
`list()` stays loud over corruption for an audit. `store()` reconciles on byte
identity rather than the algorithm-tagged digest string, so two stores holding the
same bytes under different digest algorithms reconcile idempotently instead of
throwing a spurious conflict -- verified byte-for-byte, bounded by the stored
entry's size, so a lying or oversized replica still fails closed. The disk backend's
blob rename now rides out a transient filesystem fault as its sidecar and claim
renames already do. Crash recovery and the claimed-read path are hardened
throughout: a live reader's claim is guarded from the moment acquisition begins, so
a forward wall-clock step can never hand a once-only entry to a second reader nor
destroy a read mid-drain; a claim orphaned by a faulted resolution is always
reclaimed rather than stranded; a crash-corrupted sidecar on a claimed entry no
longer wedges every operation; and a replicated entry with an exhausted read budget
is rejected.

## Backend contract and conformance harness -- SHIPPED (0.1.16)

The SPEC.md 9 backend interface becomes a declared stable contract with an
executable form: the `@blamejs/stash/conformance` subpath exports
`runBackendConformance(factory, { test })`, the behavioral suite the in-tree memory
and disk backends pass, so a store this library does not bundle certifies
interchangeability against the same cases without cloning the repository. It imports
no test runner, so a backend author wires their own. A prototype-key-confusion class
(CWE-1321) is closed in the two lookups keyed by untrusted strings -- a stored
digest's algorithm prefix and a CLI subcommand token -- which could resolve an
inherited `Object.prototype` member as a phantom; both now gate membership on
`Object.hasOwn`, guarded by a source-wide detector. Documentation gains a CommonJS
consumption guarantee, a soundness criterion for the `'burn'` pop-failure trade, the
Node-floor rationale, and the memory backend's claim semantics without a filesystem.

## Standing constraints

Every milestone honors the one rule (no decrypt capability), zero
dependencies, ESM-only, streaming-first, and the do-not-build list (`SPEC.md`
sections 1-3). The constructor refuses options whose milestone has not
shipped -- nothing is ever accepted-but-unenforced.
