# Migrating

Operator-facing migration recipes, one per breaking change. When a breaking change ships, this file gains a section describing what changed, why, and the exact upgrade steps -- committed in the same release, so operators can diff it against the prior tag.

## Policy

- **Pre-1.0:** any release may change consumer-facing surface, and there are no backwards-compatibility shims -- operators upgrade across breaking changes by following the recipe recorded here. Read [CHANGELOG.md](CHANGELOG.md) before upgrading.
- **Post-1.0:** a breaking change ships a deprecation warning at least one minor before removal, alongside the migration recipe in this file. The long-term support window is documented in [LTS-CALENDAR.md](LTS-CALENDAR.md).

## Upgrading to 2.0

Two error verdicts change, and nothing else does. The verb set, the ref format, the on-disk sidecar format, expiry, read budgets, replication, digest agility, and the CLI are all unchanged. A store written by any `v1.x` release is read by `v2.0` without migration -- there is no format change, no rewrite step, and no data to convert. Upgrade with `npm install @blamejs/stash@2` and make the edits below only if they apply to you.

This major ships without a preceding deprecation minor, so read both items rather than relying on having been warned at runtime.

### 1. An oversized `meta` throws `IntegrityError`, not `TypeError`

Pushing or storing an entry whose metadata is too large for a sidecar previously threw a bare `TypeError` carrying no `code`. It now throws `IntegrityError` with code `EINTEGRITY`, the same verdict the read side of that identical bound has always used.

If you catch that case, change the class you match on:

```js
// before
try { await stash.push(bytes, { meta }); }
catch (err) { if (err instanceof TypeError) { /* meta too large */ } }

// after
import { IntegrityError } from "@blamejs/stash";
try { await stash.push(bytes, { meta }); }
catch (err) { if (err instanceof IntegrityError) { /* meta too large */ } }

// or, branching on the code as the README recommends
catch (err) { if (err.code === "EINTEGRITY") { /* meta too large */ } }
```

If you do not catch it specifically -- if an oversized `meta` is simply a bug you let propagate -- no change is needed.

The message no longer names a verb. It previously read `push: meta too large for a sidecar` even when `store()` was the caller, because the bound is enforced by the backend write both verbs share and that line cannot tell which one called it.

### 2. `runBackendConformance` requires `factory.name`

The harness's documented contract has always been `{ name, create() }`, and its type check has always named `name` -- but nothing enforced or used it. It is now required, must be a non-empty string, and prefixes every test title the harness registers.

```js
// before -- accepted, but every case registered an unlabelled title
runBackendConformance({ create: () => new MyBackend() }, { test });

// after
runBackendConformance({ name: "my-backend", create: () => new MyBackend() }, { test });
```

If you were already passing `name` (as the README and SPEC examples do), nothing changes except that your test titles now carry it: `my-backend: round-trips a Buffer`. If you also wrap the call in your own named suite or describe block, you may want to drop the backend name from that wrapper to avoid printing it twice.

## Upgrading to 1.0

`v1.0` is not a breaking change. It is the final `v0.1.x` surface -- every verb, option, error code, and on-disk format unchanged -- with a stability commitment attached: from here, a breaking change ships a new major, preceded by a deprecation warning at least one minor ahead and a recipe in this file. A store written by any recent `v0.1.x` release is read without migration by `v1.0`. Upgrading is `npm install @blamejs/stash@1` with no code changes.

## Active deprecations

None. Nothing in `v2.0` is deprecated, and no surface is scheduled for removal.
