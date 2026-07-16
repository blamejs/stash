---
name: Bug report
about: Report a defect in the store (push/pop lifecycle, expiry, limits, integrity, replication)
title: ''
labels: bug
assignees: ''
---

<!--
Security bug? Don't file here -- see SECURITY.md for the private
disclosure process. Public issues are for non-security defects.

Before filing: search existing issues to avoid duplicates.

NEVER paste a ref from a live store: a ref is a bearer capability, and a
ref in an issue is a leaked capability. Reproduce with a fresh throwaway
store and refs that hold nothing real.
-->

## What happened

<!-- One or two sentences. What did the store do that you didn't expect. -->

## What you expected

<!-- If the store threw, which error did you expect instead? The frozen
codes are RefNotFound (ENOREF), RefClaimed (ECLAIMED), IntegrityError
(EINTEGRITY), SizeExceeded (E2BIG), StashFull (EFULL), InvalidRef
(EBADREF) -- see SPEC.md section 10. -->

## How to reproduce

<!-- Minimal repro. Code snippet preferred over prose. Include:
  - the ref STRING SHAPE that triggers it (e.g. "v1_..", a URL-encoded
    traversal, an over-long ref) -- from a throwaway store only
  - the source you pushed (Buffer vs Readable, its size, whether the
    stream errors mid-flight)
  - the options in play (ttl, reads, maxSize, maxEntries, sweepInterval)
-->

```js
import { Stash } from "@blamejs/stash";

// minimal repro
```

## Store layout (disk backend bugs)

<!-- For DiskBackend defects, the on-disk state matters more than the
code path. Sketch the .stash/ tree at the moment of failure -- which of
blobs/ meta/ claims/ tombstones/ hold entries, any orphaned .tmp files,
any planted symlink. Redact ids if the store held anything real. -->

```
.stash/
|-- blobs/
|-- meta/
|-- claims/
`-- tombstones/
```

## Environment

- `@blamejs/stash` version: `v0.X.Y` (or main `<sha>`)
- Node.js version: `node --version`
- OS + filesystem (disk backend bugs): e.g. Linux ext4, macOS APFS, Windows NTFS
- Backend: disk / memory
- Running under `--permission`? If so, the exact `--allow-fs-*` grants

## Logs / output

<details><summary>Click to expand</summary>

```
paste error codes and stack traces here -- error messages never contain
refs or paths by design (SPEC.md section 10), so they are safe to paste
```

</details>

## What you've already tried

<!-- Helpful for ruling out duplicates / known interactions. -->

## Additional context
