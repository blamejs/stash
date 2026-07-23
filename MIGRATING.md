# Migrating

Operator-facing migration recipes, one per breaking change. When a breaking change ships, this file gains a section describing what changed, why, and the exact upgrade steps -- committed in the same release, so operators can diff it against the prior tag.

## Policy

- **Pre-1.0:** any release may change consumer-facing surface, and there are no backwards-compatibility shims -- operators upgrade across breaking changes by following the recipe recorded here. Read [CHANGELOG.md](CHANGELOG.md) before upgrading.
- **Post-1.0:** a breaking change ships a deprecation warning at least one minor before removal, alongside the migration recipe in this file. The long-term support window is documented in [LTS-CALENDAR.md](LTS-CALENDAR.md).

## Upgrading to 1.0

`v1.0` is not a breaking change. It is the final `v0.1.x` surface -- every verb, option, error code, and on-disk format unchanged -- with a stability commitment attached: from here, a breaking change ships a new major, preceded by a deprecation warning at least one minor ahead and a recipe in this file. A store written by any recent `v0.1.x` release is read without migration by `v1.0`. Upgrading is `npm install @blamejs/stash@1` with no code changes.

## No migrations

No breaking-change migrations have shipped -- every release through `v1.0` has been additive or a stability commitment. There are no active deprecations and no migration steps.
