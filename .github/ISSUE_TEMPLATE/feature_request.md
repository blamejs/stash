---
name: Feature request
about: Propose a new store capability, backend behavior, or API surface
title: ''
labels: enhancement
assignees: ''
---

<!--
Read SPEC.md section 3 ("Do not build these") FIRST. Encryption, content
addressing, compression, node:sqlite, eviction, TTL extension,
namespaces, sync transports, cloud backends, and content inspection are
each a considered rejection, not a gap -- a request for one of them needs
an argument against the recorded reasoning, not just a use case.

File the issue before opening a PR; it saves a round of rework.
-->

## Problem

<!-- What storage task are you solving? Concrete scenario preferred over
abstract. Which SPEC.md section is closest to the surface you want to
change (section 4 API, section 7 expiry, section 8 limits, section 9
backends, section 4.4 replication)? -->

## Proposed surface

<!-- What does the caller's API look like? Show the call site. -->

```js
import { Stash } from "@blamejs/stash";

// imagined usage
```

## Fit with the one rule

<!-- SPEC.md section 1: the store cannot decrypt anything and has nowhere
to put a key. Does the proposal require the store to understand blob
contents in any way? If yes, the proposal belongs in a consumer, not
here. -->

## Initial-release scope

What's IN the first shipped version:
-

What's explicitly OUT (and why each "out" is a complete decision, not a
deferred bullet):
-

## Failure modes

<!-- Which of the frozen error codes (SPEC.md section 10) does the new
surface throw, and when? If a NEW code is needed, that is a spec change --
say so explicitly. Codes: ENOREF, ECLAIMED, EINTEGRITY, E2BIG, EFULL,
EBADREF. Error messages must never contain a ref, a meta value, or a
path. -->

- Bad options at construction -> throw immediately, typed
- Hostile input (malformed ref, oversized stream, planted symlink) -> reject fail-closed with which code?

## Sandbox posture

<!-- SPEC.md section 2.1: the store runs under `--permission` scoped to
its root. Does the proposal need any new grant (child process, worker,
network, a path outside the root)? Each new grant widens the sandbox and
needs its own justification. -->

## Both backends

<!-- Disk and memory share one conformance suite (SPEC.md section 13).
How does the behavior manifest on each? -->

## Alternatives considered

<!-- What did you rule out and why. Saves the reviewer asking. -->

## Additional context
