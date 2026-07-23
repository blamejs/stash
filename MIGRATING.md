# Migrating

Operator-facing migration recipes, one per breaking change. When a breaking change ships, this file gains a section describing what changed, why, and the exact upgrade steps -- committed in the same release, so operators can diff it against the prior tag.

## Policy

- **Pre-1.0:** any release may change consumer-facing surface, and there are no backwards-compatibility shims -- operators upgrade across breaking changes by following the recipe recorded here. Read [CHANGELOG.md](CHANGELOG.md) before upgrading.
- **Post-1.0:** a breaking change ships a deprecation warning at least one minor before removal, alongside the migration recipe in this file. The long-term support window is documented in [LTS-CALENDAR.md](LTS-CALENDAR.md).

## No migrations

No breaking-change migrations have shipped yet -- every 0.1.x release has been additive. There are no active deprecations and no migration steps.

### Note: disk layout gains `delivered/` (0.1.17)

0.1.17 adds a `delivered/` directory to the disk-backend layout (it records that a `'burn'` claim streamed a byte, so crash recovery restores a never-read entry instead of destroying it -- see [CHANGELOG.md](CHANGELOG.md)). This needs **no action**: the library and the `stashjs` CLI create the directory automatically on first use, and a stash written by an earlier version -- which has no `delivered/` -- is still recognized and served. It is called out only so the new directory in your stash root is not a surprise.
