# Support

Thanks for using `@blamejs/stash`. This page points you at the right channel for
whatever you need.

## Where to go

| I want to... | Go here |
|---|---|
| Understand the API and its guarantees | [SPEC.md](SPEC.md) -- the authoritative specification |
| See what is built today and what's planned | [ARCHITECTURE.md](ARCHITECTURE.md) (implementation status) and SPEC.md section 12 (milestones) |
| See what changed between versions | [CHANGELOG.md](CHANGELOG.md) |
| Ask a usage question or propose a feature | [GitHub Discussions](https://github.com/blamejs/stash/discussions) |
| Report a reproducible bug | [GitHub Issues](https://github.com/blamejs/stash/issues) |
| Report a security vulnerability | **Privately** -- GitHub's ["Report a vulnerability"](https://github.com/blamejs/stash/security/advisories/new) form. Do not open a public issue. |

## Before you open an issue

A tight report gets a fast answer. Please include:

- The version you are on -- a `v0.X.Y` tag, or the `main` `<sha>` you tested.
- Your Node.js version (`node -v`). The library targets Node 24.18.0+ and runs on
  the shipped runtime with no build step.
- A **minimal reproducer** -- ideally a short script against the `MemoryBackend`,
  which needs no filesystem setup. If the behavior is disk- or permission-model-
  specific, say so and include the `--permission` flags you launched with.
- What you expected, and what actually happened. If a call threw, include the
  error's class name and its `.code` (e.g. `RefNotFound` / `ENOREF`) -- those
  codes are stable and make triage fast.
- **Never paste a live ref, a `meta` value, or a stash path from a production
  store into an issue.** A ref is a capability; a ref in a public issue is a
  leaked capability. Reproduce with throwaway data.

A method throwing a typed error on malformed or expired input is usually the
library working as designed (it fails loudly on purpose -- rejection is the
feature). If you believe an input *should* be accepted and is not -- or *should*
be rejected and is not -- that is exactly the kind of report we want.

## Versions and upgrades

Pre-1.0, the supported version is the latest published release. Older lines do
not receive backports. Breaking-change policy and upgrade recipes live in
[MIGRATING.md](MIGRATING.md); the long-term support commitment is in
[LTS-CALENDAR.md](LTS-CALENDAR.md).

## Security

Security reports do not go through Issues or Discussions. Report privately via
GitHub's ["Report a vulnerability"](https://github.com/blamejs/stash/security/advisories/new)
advisory form. The threat model -- what the library defends and what is out of
scope -- is documented in [THREAT-MODEL.md](THREAT-MODEL.md).

## License

`@blamejs/stash` is [Apache-2.0](LICENSE) licensed.
