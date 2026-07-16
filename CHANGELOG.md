# Changelog

All notable changes to `@blamejs/stash` are documented here, newest first.

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
