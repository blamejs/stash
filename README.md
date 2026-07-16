# @blamejs/stash

**A zero-dependency, ephemeral, crypto-agnostic content store for Node.js.**

You put bytes in. You get a ref back. You take the bytes out once, and they're
gone.

```js
import { Stash } from "@blamejs/stash";
import { MemoryBackend } from "@blamejs/stash/backends/memory";

const stash = new Stash({ backend: new MemoryBackend() });

const ref = await stash.push(ciphertext, { meta: { kind: "drop" } });
// 'v1_...' -- 256 bits of random capability, never a content hash

const readable = await stash.apply(ref);   // digest-verified stream
await stash.drop(ref);                     // gone
```

## Why this store

- **It can't decrypt anything.** No method takes a key; no cipher primitive is
  imported anywhere in the tree, and CI proves it on every commit. A store
  that *chooses* not to decrypt is a promise; a store with nowhere for a key
  to live is an architecture. Encryption belongs to the layer above.
- **Refs are capabilities, not addresses.** `v1_` + 32 random bytes,
  unguessable, never derived from content -- so holding a suspect document
  never lets anyone probe whether it is stored. Ref validation is a strict
  whitelist that doubles as path-traversal defense.
- **Write-once, monotone lifecycle.** Every state change moves an entry closer
  to destruction -- read budgets only decrement, expiry only arrives, and
  nothing can argue an entry back from the brink. There is no `touch()`.
- **Fail-closed verdicts.** Every failure is a typed `StashError` with a
  frozen `.code`; no path returns a default in place of an answer, and no
  error message ever contains a ref, a `meta` value, or a path.
- **Zero dependencies.** Runtime *and* development. Node builtins only, ESM,
  no build step. `npm install @blamejs/stash` adds exactly one package.

## Install

```
npm install @blamejs/stash
```

Requires Node `>= 24.18.0`.

## What ships today

The M1 + M2 surface (see `SPEC.md` section 12 for the full delivery plan):

- `push` / `apply` / `show` / `list` / `drop` / `clear` over either backend,
  with size and `sha256` digest computed as the bytes stream through and
  digest-verified reads.
- **The disk backend** (`@blamejs/stash/backends/disk`): one blob + one JSON
  sidecar per entry, no central index to corrupt, atomic
  tmp-fsync-rename writes, `0700`/`0600` modes, realpath containment that
  refuses planted symlinks instead of following them, and strict
  size-bounded sidecar validation -- corruption is a typed `IntegrityError`,
  never silently bad bytes and never a silent skip.
- The in-memory backend, same contract, for tests and process-lifetime
  stashes. One conformance suite runs against both, unmodified.
- The full typed error set (`RefNotFound`, `RefClaimed`, `IntegrityError`,
  `SizeExceeded`, `StashFull`, `InvalidRef` -- all `StashError`, all with
  frozen codes).
- Ref generation and whitelist validation.

Spec'd options whose milestone has not shipped (`ttl`, `maxSize`,
`onPopFailure`, ...) **throw at construction** rather than sitting silently
unenforced -- a security option that is accepted but ignored would be a
fail-open default.

Next up, in order: expiry, mid-stream limits, the claim/commit `pop` cycle
with read budgets, audit (`verify`), and the replication primitives
(`store`, tombstones). `ROADMAP.md` tracks status; `SPEC.md` is the
contract.

## Run it sandboxed

StashJS is designed to run under the Node permission model, with filesystem
grants scoped to the store and nothing else:

```
node --permission --allow-fs-read=./.stash/* --allow-fs-write=./.stash/* app.js
```

A compromised dependency elsewhere in your tree cannot read the stash, and
StashJS cannot read anything else. (On Node 24.x `--permission` does not gate
the network; StashJS opens no sockets regardless.) The store never spawns
child processes, never starts worker threads, and never accepts a file
descriptor as input, so no wider grant is ever needed.

## Documentation

- `SPEC.md` -- the full specification: API, semantics, threat reasoning, and
  the do-not-build list.
- `ARCHITECTURE.md` -- the policy/backend split and the design invariants.
- `THREAT-MODEL.md` -- what the store defends against, and what it refuses to
  pretend to defend against.
- `examples/wiki` -- the documentation site, generated from the source's own
  comment blocks (`npm run wiki:e2e` proves it; `node examples/wiki/server.js`
  serves it).

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
