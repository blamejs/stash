# Migrating

Operator-facing migration recipes, one per breaking change. When a breaking
change ships, this file gains a section describing what changed, why, and the
exact upgrade steps, committed in the same release so you can diff it against the
prior tag.

## Policy

A breaking change ships a deprecation warning at least one minor before removal,
alongside the migration recipe in this file. The long-term support window is
documented in [LTS-CALENDAR.md](LTS-CALENDAR.md).

That commitment took effect at `v1.0`. Before it, any `v0.x` release could change
consumer-facing surface with no backwards-compatibility shims, and operators
upgraded by following the recipe recorded here. Read
[CHANGELOG.md](CHANGELOG.md) before upgrading across several releases.

**Exceptions taken.** The rule above is the commitment. Where a release has not
met it, it is named here rather than left for you to discover.

| Release | What was skipped | Why |
|---------|------------------|-----|
| `v2.0.0` | No deprecation minor preceded it. | Both changes are error-reporting corrections on paths that were already wrong. One reported a verb the caller never invoked; the other left a documented contract unenforced. A deprecation minor would have had to warn on a code path most callers never reach, and the recipe below is two mechanical edits. See [Upgrading to 2.0](#upgrading-to-20). |
| `v2.1.0` | A consumer-visible change shipped as a minor rather than a major. | The default `digest` changed from `sha256` to `sha3-512`, so entries written by `v2.1` carry a different digest string from entries written by `v2.0`. Under the commitment above that is a major. It ships as a minor by maintainer decision, on the grounds that the store was built for mixed algorithms: stored digests are self-describing, existing entries keep verifying under the algorithm they were written with, replication reconciles on byte identity rather than the digest string, and no signature, option, error code, or on-disk layout changed. Anything comparing digest strings across versions is affected. See [Upgrading to 2.1](#upgrading-to-21). |

## Upgrading to 2.1

The default integrity hash changed from `sha256` to `sha3-512`. Nothing else
changed: same verbs, same options, same error codes, same on-disk layout. There
is no migration step and no data to convert.

**Your existing entries are untouched and keep verifying.** A stored digest
carries its own algorithm (`"sha256:..."`, `"sha3-512:..."`), so an entry
written under `v2.0` is still read, verified, and audited with `sha256`. A store
may hold both, and `verify()` reports clean across the mix. Replication
reconciles on byte identity rather than on the digest string, so a `v2.0` store
and a `v2.1` store still converge.

What changes is what NEW pushes record: `sha3-512:<128 hex>` where it used to be
`sha256:<64 hex>`.

You need to do something only if one of these is true:

- **You compare digest strings across stores or versions.** Two stores holding
  identical bytes will now report different digest strings if one was written
  before the upgrade and one after. Compare bytes, or compare `size`, or pin the
  algorithm explicitly.
- **You persist or assert on the digest outside the store.** A fixture, a golden
  file, or a downstream index keyed on the digest string sees new values for new
  entries.
- **You are near a size ceiling.** A `sha3-512` digest is 64 more hex characters
  than a `sha256` one, so each entry's metadata grows by roughly that much.
  `maxTotal` counts the stored footprint including metadata.
- **Hash throughput matters to you.** SHA-3 has no hardware acceleration where
  SHA-2 does. On the maintainer's machine `sha3-512` measured about 392 MiB/s
  against `sha256`'s 2546 MiB/s, and the store hashes every byte on the way in
  and again on every verified read.

To keep the previous behaviour exactly, name it:

```js
const stash = new Stash({ backend, digest: "sha256" });
```

That option has existed since `v0.1.12` and is unchanged.

## Upgrading to 2.0

Two error verdicts change class, one error message drops a verb it should never
have named, and a copy that could store bytes you never supplied is fixed.

The verb set, the ref format, the on-disk sidecar format, expiry, read budgets,
replication, digest agility, and the CLI are all unchanged. A store written by
any `v1.x` release is read by `v2.0` without migration: no format change, no
rewrite step, no data to convert. Upgrade with `npm install @blamejs/stash@2` and
make the edits below only if they apply to you.

This major ships without a preceding deprecation minor. See
[Exceptions taken](#policy) above.

Only items 1 and 2 can require a code change. The rest are listed so you know
what moved:

- The shared source check's `TypeError` message no longer begins `push:`. It is
  reached from both `push()` and `store()`, so it never should have. If you match
  on that message text rather than the class, update the match.
- A source that misreports its `length`, such as a `Uint8Array` subclass
  overriding the property, is now copied by its real byte length. Previously the
  store recorded the claimed length, padding the entry with unrelated process
  memory. No API changes. Entries written by the old behavior keep whatever bytes
  were recorded, and `verify()` will not flag them, because their digests were
  computed over the padded content.

### 1. An oversized `meta` throws `IntegrityError`, not `TypeError`

Pushing or storing an entry whose metadata is too large for a sidecar previously
threw a bare `TypeError` carrying no `code`. It now throws `IntegrityError` with
code `EINTEGRITY`, the same verdict the read side of that identical bound has
always used.

If you catch that case, change the class you match on:

```js
// before
try { await stash.push(bytes, { meta }); }
catch (err) { if (err instanceof TypeError) { /* meta too large */ } }

// after
import { IntegrityError } from "@blamejs/stash";
try { await stash.push(bytes, { meta }); }
catch (err) { if (err instanceof IntegrityError) { /* meta too large */ } }

// or, branching on the code as the README recommends, with no import needed
try { await stash.push(bytes, { meta }); }
catch (err) { if (err.code === "EINTEGRITY") { /* meta too large */ } }
```

This bound belongs to the disk backend, which stores each entry's metadata in a
sidecar file. `MemoryBackend` has no such bound, so nothing changes there.

If you do not catch it specifically, and an oversized `meta` is simply a bug you
let propagate, no change is needed.

The message no longer names a verb. It previously read `push: meta too large for
a sidecar` even when `store()` was the caller, because the bound is enforced by
the backend write both verbs share, and that line cannot tell which one called
it.

### 2. `runBackendConformance` requires `factory.name`

The harness's documented contract has always been `{ name, create() }`, and its
type check has always named `name`, but nothing enforced or used it. It is now
required, must be a non-empty string, and prefixes every test title the harness
registers.

```js
// before: accepted, but every case registered an unlabelled title
runBackendConformance({ create: () => new MyBackend() }, { test });

// after
runBackendConformance({ name: "my-backend", create: () => new MyBackend() }, { test });
```

If you were already passing `name`, as the README example does, nothing changes
except that your test titles now carry it: `my-backend: round-trips a Buffer`. If
you also wrap the call in your own named suite or describe block, you may want to
drop the backend name from that wrapper to avoid printing it twice.

## Upgrading to 1.0

`v1.0` is not a breaking change. It is the final `v0.1.x` surface, with every
verb, option, error code, and on-disk format unchanged, and a stability
commitment attached: from there on, a breaking change ships a new major, preceded
by a deprecation warning at least one minor ahead and a recipe in this file. A
store written by any recent `v0.1.x` release is read without migration by `v1.0`.
Upgrading is `npm install @blamejs/stash@1` with no code changes.

`v1.x` is no longer serviced. If you are upgrading from `v0.x` today, go straight
to `v2.x`; see [LTS-CALENDAR.md](LTS-CALENDAR.md).

## Active deprecations

None. Nothing in `v2.0` is deprecated, and no surface is scheduled for removal.
