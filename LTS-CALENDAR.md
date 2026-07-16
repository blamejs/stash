# LTS calendar

`@blamejs/stash` ships on a published major cadence. Each major receives **24 months of security-only patches** starting the day the next major is published. Feature backports are not promised.

| Version          | First release | Security patches through   | Node minimum | Dependency posture |
|------------------|---------------|----------------------------|--------------|--------------------|
| `v0.x` (pre-1.0) | 2026          | until v1.0 ships           | 24.18.0      | Zero dependencies, runtime and dev |
| `v1.x`           | TBD           | first release + 24 months  | current LTS  | Zero dependencies, runtime and dev |

## What "security patches" means

- Critical and high-severity vulnerabilities in the library's own code -- a ref-validation or containment escape, a capability leak through an error or an API surface, a destruction guarantee that fails to hold, resource exhaustion in the streaming paths.
- **Not** included: feature backports, performance improvements, or non-security bug fixes. Consumers who want those upgrade to the current major.
- There are no dependencies -- runtime, dev, or vendored -- so there is no third-party-CVE patch lane. A vulnerability is either in this library's code or in Node itself; the latter is fixed by upgrading Node within the supported floor.

## Node minimum policy

The "Node minimum" column is the lowest Node version the library supports for that line. The `v0.x` line is pinned to 24.18.0 as a floor, not a ceiling -- no polyfills, no compat shims, no version branches for older runtimes. A new major adopts whatever Node major is the active LTS at release. Once on the LTS line, the Node minimum is frozen for that major's security-patch window -- consumers on the LTS line are not forced onto a newer Node mid-window. Nothing is transpiled, so the supported Node version is exactly the version the source runs on.

## Pre-1.0 caveat

`v0.x` has no LTS commitment. Every release may change something consumers depend on, and there are no backwards-compatibility shims across pre-1.0 breaking changes -- the surface is intentionally evolving toward the contract in [SPEC.md](SPEC.md). Read [CHANGELOG.md](CHANGELOG.md) before upgrading across more than a few releases at a time. The LTS calendar takes effect at v1.0, together with the deprecation policy in [MIGRATING.md](MIGRATING.md).
