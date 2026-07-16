# Migrating

Operator-facing migration recipes, one per breaking change. When a breaking change ships, this file gains a section describing what changed, why, and the exact upgrade steps -- committed in the same release, so operators can diff it against the prior tag.

## Policy

- **Pre-1.0:** any release may change consumer-facing surface, and there are no backwards-compatibility shims -- operators upgrade across breaking changes by following the recipe recorded here. Read [CHANGELOG.md](CHANGELOG.md) before upgrading.
- **Post-1.0:** a breaking change ships a deprecation warning at least one minor before removal, alongside the migration recipe in this file. The long-term support window is documented in [LTS-CALENDAR.md](LTS-CALENDAR.md).

## No migrations

No releases have shipped yet. There are no active deprecations and no migration steps.
