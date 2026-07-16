# Security Policy

`@blamejs/stash` is an ephemeral content store whose security posture is
architectural: there is nowhere in it to put a decryption key, refs are 256-bit
random capabilities rather than content addresses, ref validation is a strict
whitelist that doubles as path-traversal defense, and every failure is a typed
error that never echoes a ref, a `meta` value, or a filesystem path. This
document describes how to report a vulnerability, which versions are supported,
and how an operator hardens a deployment that embeds the store.

---

## Reporting a vulnerability

**Do not open a public issue for a security report.**

Report privately through GitHub's **["Report a vulnerability"](https://github.com/blamejs/stash/security/advisories/new)**
private advisory form on the repository's Security tab. This opens a private
channel with the maintainers.

Please include:

- Affected version (`v0.X.Y` tag, or the `main` `<sha>` you tested)
- A description of the issue and the impact you observed
- A minimal reproducer -- the smallest sequence of calls, hostile ref string,
  or corrupted store layout that triggers the behavior
- Whether you have discussed this with anyone else, and any coordinated-
  disclosure timeline you are working to

The store's dominant attack surfaces are **hostile ref strings** (path
traversal), **hostile push sources** (resource exhaustion), and **a hostile
store directory** (symlinks, planted corruption). Reproducers in those shapes
are especially valuable.

### Response targets

| Severity | First response | Triage / acknowledgment | Fix released |
|---|---|---|---|
| Critical (ref whitelist bypass, containment escape, bytes served for a foreign ref) | within 72 h | within 7 d | next patch |
| High (fail-closed guarantee broken, capability leaked into an error or log surface, integrity check bypassed) | within 7 d | within 14 d | next patch |
| Medium (unbounded work / DoS on adversarial input) | within 14 d | within 30 d | next patch |
| Low (defense-in-depth gaps) | within 30 d | as scheduled | next release |

## Supported versions

Pre-1.0, only the latest published `0.x.y` receives fixes. See
`LTS-CALENDAR.md` for the support policy that applies from 1.0.

## Continuous fuzzing

The store's untrusted-input surfaces -- hostile ref strings and the disk
backend's sidecar bytes -- are fuzzed continuously with ClusterFuzzLite
(jazzer.js): pull requests that touch `src/` get a short fuzzing burst
against the changed code, and a scheduled batch run fuzzes the grown corpus
daily. The targets treat a typed `StashError` as the correct fail-closed
verdict on hostile input; anything else that escapes -- an untyped
exception, a hang -- is reported as a crash. The harness lives in
`.clusterfuzzlite/` (with a plain-node seed-corpus check at
`node .clusterfuzzlite/local-smoke.js`) and never ships in the npm tarball.

## Hardening a deployment

- **Run under the Node permission model.** The store is designed to run with
  filesystem grants scoped to its root and nothing else:

  ```
  node --permission --allow-fs-read=./.stash/* --allow-fs-write=./.stash/* app.js
  ```

  Note that `--permission` does not gate the network on Node 24.x; StashJS
  opens no sockets regardless.

- **Let the store own its directory.** The disk backend creates its layout
  `0700`/`0600` and enforces realpath containment itself -- a symlink
  planted inside the root is refused, not followed (the permission model
  alone does not stop symlink escapes). Point `root` at a dedicated
  directory and let the backend create it rather than pre-seeding it.
- **Never log refs or `meta` values.** A ref is a capability; a ref in a log
  file is a leaked capability. Log counts and error codes.
- **Treat `StashError` codes as the branch surface.** Messages may change
  between patches; codes are frozen (see SPEC.md section 10).
- **Size the store's limits before exposing `push` to any network path.**
  `maxSize` bounds each entry mid-stream and `maxEntries` / `maxTotal` bound the
  whole store, so a request flood -- or a single unbounded upload -- becomes a
  loud `SizeExceeded` / `StashFull` instead of a full disk. An oversized source
  is cut off at the limit, not written and then measured, and a rejected push
  leaves no partial behind.

## What StashJS deliberately does not do

StashJS cannot decrypt anything -- no method takes a key, and no cipher
primitive is imported anywhere in the tree (a CI-enforced invariant, SPEC.md
section 13.1). It does not deduplicate, compress, inspect, or index contents.
The threat model behind each refusal is in `THREAT-MODEL.md` and SPEC.md
section 3.
