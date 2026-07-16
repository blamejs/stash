# Contributing to @blamejs/stash

Thanks for considering a contribution. `@blamejs/stash` is a zero-dependency, ephemeral, crypto-agnostic content store for Node.js with strong architectural defaults -- this doc is the guide to making your patch land cleanly. [SPEC.md](SPEC.md) is the authoritative specification; every design question is settled there before it is settled in code.

## Quick links

- **Found a bug?** Open an issue with a minimal reproducer. For security bugs, **don't** open a public issue -- report privately via GitHub's ["Report a vulnerability"](https://github.com/blamejs/stash/security/advisories/new) form.
- **Have a feature idea?** Read [SPEC.md](SPEC.md) section 3 ("Do not build these") first -- several obvious improvements are deliberately rejected there, with reasoning. If your idea survives that list, open an issue to discuss the design before writing code.
- **Want to ship a fix?** Read [Development setup](#development-setup), [House rules](#house-rules), and [The PR loop](#the-pr-loop) below.

## Development setup

```bash
# 1. Clone. There is no install step: zero dependencies, including dev dependencies.
git clone https://github.com/blamejs/stash.git
cd stash

# 2. Run the test suite (node:test, no framework)
node --test test/

# 3. Run the static gates (CI runs all of them)
npm run gates   # codebase-patterns + comment-block validator + api-snapshot

# 4. Run the suite under the Node permission model, scoped to the test root
npm run test:sandboxed
```

**Requirements:** Node.js 24.18.0 or newer (see `.node-version`). The library targets that floor as a floor, not a ceiling -- no polyfills, no compat shims, no version branches for older runtimes. Nothing is transpiled -- what ships is what runs.

## House rules

These are the project's hard rules. Patches that violate them get bounced regardless of how clean the code is.

### SPEC.md is the contract

The spec is written first and the code follows it. A patch that changes observable behavior either matches what SPEC.md already says, or arrives together with the spec change and the argument for it. If a task seems to require the store to understand the contents of a blob, the task is wrong -- stop and ask (SPEC.md section 1).

### Zero dependencies -- including dev dependencies

Not one runtime dependency. Not one dev dependency. Node builtins only; tests use `node:test` and `node:assert/strict`. If your change cannot be completed without adding a package, open an issue rather than adding it. There is no vendoring escape hatch here -- the dependency count is zero, full stop.

### No cryptography beyond hashing and random IDs

`node:crypto` may be imported for `createHash`, `randomBytes`, and `timingSafeEqual` -- never `createCipheriv` or `createDecipheriv`. There is no key parameter on any method and no place for one to live. The absence of the capability is the product: a store with nowhere to put a key survives the threat model "someone compels the operator." Encryption is the consumer's layer, not this one.

### The do-not-build list

SPEC.md section 3 is load-bearing. No encryption, no content addressing or dedup, no compression, no `node:sqlite` index, no content inspection, no HTTP server, no cloud backends, no eviction, no TTL extension, no namespaces, no sync transport, no logging of refs or metadata, no telemetry. Each entry has its reasoning in the spec; a PR that adds one of these will be closed with a pointer to it.

### Fail loud, typed errors

Every failure surfaces as a typed error extending `StashError` with a stable `.code` (`ENOREF`, `ECLAIMED`, `EINTEGRITY`, `E2BIG`, `EFULL`, `EBADREF`). Consumers must never need to string-match a message. **No error message ever contains a ref, a `meta` value, or a path** -- refs are capabilities, and error text is for developers. A default that silently degrades (evicting to make room, accepting a malformed ref after "cleanup") is a bug, not an ergonomic.

### Streaming-first

No method may buffer an entire blob in memory. Size limits are enforced mid-stream -- count bytes as they pass and abort the moment a limit is crossed, never write the whole thing and then check. A failed or rejected write leaves nothing behind.

### The monotone rule

Entry lifecycle only moves toward destruction: `readsLeft` only decrements, claims only resolve, expiry only arrives. Anything that would let an entry live longer than its terms at push time is rejected on sight (SPEC.md section 4.2). New terms mean a new push.

### Code style

- **ESM only.** `"type": "module"`, plain JavaScript. No TypeScript, no build step, no bundler. Consumers read the same source the runtime executes.
- **No child processes, no worker threads, no native addons, no WASI.** Each would widen the permission-model sandbox (SPEC.md section 2.1). Paths only -- never accept a file descriptor as input.
- **Timers that must not hold the process open are `.unref()`'d.** The sweep timer is the canonical case.
- **Source files are pure ASCII.**

### Executable invariants

Two rules from SPEC.md section 13.1 are wired into CI as machine-enforced checks, and your patch must keep them green:

1. Grepping the source for `createCipheriv`, `createDecipheriv`, `node:sqlite`, and `password` yields zero hits.
2. The full suite passes under `node --permission` with filesystem grants scoped to the test root only. If your change quietly requires a broader grant, the sandbox catches it at the point the change is made.

### Test coverage

Tests run with plain `node --test`; no framework. Backends share one conformance suite run against every backend, so a new backend inherits the whole behavioral contract. The non-negotiable cases are enumerated in SPEC.md section 13 -- concurrency races on `pop`, mid-stream aborts, crash recovery, traversal refs, symlink containment, budget accounting, tombstone convergence.

New behavior lands with a test that **reproduces the failure first** (red on the current tree, green on the fix), driving the real consumer path (`stash.push(...)` / `stash.pop(ref)`, not a poked backend internal) with the adversarial input that triggers it. Root-cause the whole class the bug samples, not just the one input. Use `await using` for any test that needs a live `Stash`.

## Developer Certificate of Origin (DCO)

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/). By adding a `Signed-off-by` line to each commit you certify that you wrote the patch -- or otherwise have the right to submit it -- under the project's Apache-2.0 license. Sign off with `git commit -s` (which appends `Signed-off-by: Your Name <you@example.com>`); the sign-off must match the commit author.

## The PR loop

1. **Open an issue first** for non-trivial work -- design discussion catches scope problems before code is written, and checks the idea against SPEC.md section 3. Trivial fixes (typos, doc tweaks, single-line bug fixes) can skip the issue.
2. **Branch off `main`.** Branch name doesn't matter; we squash on merge.
3. **One concern per PR.** A new capability + its tests + its docs is one PR. A new capability + an unrelated cleanup is two.
4. **Fail-loud verification before push:**
   - `node --test test/` passes.
   - `npm run gates` exits 0 -- the structural detectors, comment-block validator, and api-snapshot are clean. Intentional public-surface changes regenerate the snapshot and commit it alongside the change.
   - `npm run test:sandboxed` passes -- the suite under `--permission` scoped to the test root.
   - The section 13.1 greps are clean (no cipher imports, no `node:sqlite`, no `password`).
5. **Commit message style:** lowercase imperative. The first line is a one-sentence summary; the body explains *why* and *what tradeoff*, and cites the SPEC.md section that governs the behavior.
6. **Open the PR.** Wait for CI green.
7. **Review feedback** focuses on:
   - Does this match the spec, or does it need a spec change first?
   - Is every failure a loud, typed error -- never a silent default, never a leaked ref in a message?
   - Does the lifecycle stay monotone?
   - Does the suite still pass under `--permission` with the same grants?

## What to contribute

**New here?** The highest-value contributions are adversarial tests: traversal ref variants, concurrency races on claims and read budgets, mid-stream aborts at unusual offsets, crash-recovery scenarios. The section 13 list is the map -- a case on that list without a test yet is a ready-made first PR.

Good contribution areas:

1. **Adversarial test vectors** -- malformed refs, symlink plants, partial-write recovery, concurrent-pop and budget races.
2. **Milestone work** -- SPEC.md section 12 sequences the build (M2 disk backend through M8 docs). Comment on the tracking issue for a milestone before starting; milestones land one at a time, in order.
3. **Documentation and runnable examples** -- especially the `--permission` launch flags and the cold-standby replication sketch the spec calls for.

What we don't want:

- Dependencies. Runtime or dev. Period.
- TypeScript ports / build steps.
- Anything on the SPEC.md section 3 list, however helpful it feels.
- A convenience default that papers over a real decision (silent eviction, TTL extension, "cleaning up" a malformed ref instead of rejecting it).

## Maintainer responsibilities

If you're being added as a maintainer, the additional commitments:

- Triage incoming issues within 7 days.
- Respond to private security reports within the advisory SLA.
- Review PRs within 14 days.
- Sign-off + tag releases.

## Getting help

- **General questions:** [GitHub Discussions](https://github.com/blamejs/stash/discussions).
- **Real-time:** the project doesn't run a Discord / Slack -- async-by-design.
- **Security:** GitHub's ["Report a vulnerability"](https://github.com/blamejs/stash/security/advisories/new) form. Never a public issue.

This document is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
