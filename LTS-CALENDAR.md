# LTS calendar

`@blamejs/stash` ships on a published major cadence. Each major receives **24 months of security-only patches** starting the day the next major is published. Feature backports are not promised.

| Version          | First release | Security patches through   | Node minimum | Dependency posture |
|------------------|---------------|----------------------------|--------------|--------------------|
| `v0.x` (pre-1.0) | 2026          | superseded by v1.0 (2026-07-23) | 24.18.0 | Zero dependencies, runtime and dev |
| `v1.x`           | 2026-07-23    | current major; 24 months after v2.0 ships | 24.18.0 | Zero dependencies, runtime and dev |

## What "security patches" means

- Critical and high-severity vulnerabilities in the library's own code -- a ref-validation or containment escape, a capability leak through an error or an API surface, a destruction guarantee that fails to hold, resource exhaustion in the streaming paths.
- **Not** included: feature backports, performance improvements, or non-security bug fixes. Consumers who want those upgrade to the current major.
- There are no dependencies -- runtime, dev, or vendored -- so there is no third-party-CVE patch lane. A vulnerability is either in this library's code or in Node itself; the latter is fixed by upgrading Node within the supported floor.

## Node minimum policy

The "Node minimum" column is the lowest Node version the library supports for that line. The `v0.x` line is pinned to 24.18.0 as a floor, not a ceiling -- no polyfills, no compat shims, no version branches for older runtimes. The capabilities the library relies on all arrived at the Node 24 major level, not in the `.18` patch (see [SPEC.md](SPEC.md) section 2); the patch level is a conservative security-currency floor -- a maintained Node 24 patch rather than an early 24.x with since-fixed defects -- so a consumer on any newer 24.x patch is fully supported. A new major adopts whatever Node major is the active LTS at release. Once on the LTS line, the Node minimum is frozen for that major's security-patch window -- consumers on the LTS line are not forced onto a newer Node mid-window. Nothing is transpiled, so the supported Node version is exactly the version the source runs on.

## The v0.x line

`v0.x` had no LTS commitment: every pre-1.0 release could change something consumers depended on, with no backwards-compatibility shims -- the surface was evolving toward the contract in [SPEC.md](SPEC.md). That contract is now stable as of `v1.0`, and this calendar and the deprecation policy in [MIGRATING.md](MIGRATING.md) are in effect. Consumers still on a `v0.x` release upgrade to `v1.x`, which is API-compatible with the final `v0.1.x` surface -- `v1.0` is the same feature-complete store with a stability commitment attached, not a breaking change. Read [CHANGELOG.md](CHANGELOG.md) before upgrading across more than a few releases at a time.
