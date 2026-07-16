// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
// concepts - the wiki's narrative pages. Each /** @concept */ block below
// becomes one page under the Concepts nav group, rendered by
// lib/page-generator with the same prose/section/related machinery the
// primitive pages use. This file is parsed for its comment blocks, never
// executed by the site.

/**
 * @concept refs-are-capabilities
 * @title   Refs are capabilities
 * @order   10
 * @related stash.push, stash.show, stash.drop
 *
 * A ref is `'v1_'` plus 32 random bytes as base64url -- 256 bits of
 * entropy, unguessable, minted fresh on every `push`. It is never derived
 * from the content, so holding a ref IS the permission to act on the
 * entry. There is no other access control layer, and none is needed: an
 * unguessable name is the capability.
 *
 * @section Why not content hashes
 *   The obvious design -- `ref = sha256(contents)` -- is wrong here for
 *   two reasons. It leaks: a content hash is guessable by anyone who has
 *   the content, so an adversary who suspects a particular document was
 *   stashed can hash it and probe for the ref -- an enumeration oracle
 *   against exactly the deployments this store serves. And it buys
 *   nothing: dedup is the usual payoff, and dedup does not work on
 *   ciphertext -- two uploads of the same encrypted file are two
 *   different byte streams.
 *
 * @section Validation is path-traversal defense
 *   Refs become filenames in the disk backend, so every ref entering a
 *   public method is validated against a strict whitelist --
 *   `/^v1_[A-Za-z0-9_-]{43}$/`, character for character -- before it
 *   touches any storage. No normalization, no cleanup-and-continue: a
 *   malformed ref dies at the regex with `InvalidRef`, not at the
 *   syscall. A digest is stored per entry, but only to verify integrity
 *   on read -- it is never a lookup key.
 *
 * @section Keep refs out of logs
 *   A ref in a log file is a leaked capability. The store never logs
 *   refs or `meta` contents, and no error message ever contains one --
 *   messages describe the failure class, and the caller already holds
 *   the identifiers it passed in. The same rule binds the embedding
 *   application: log counts and error codes, never identifiers.
 */

/**
 * @concept monotone-lifecycle
 * @title   The monotone lifecycle
 * @order   20
 * @related stash.push, stash.drop, stash.clear
 *
 * Entries are write-once, and every state change moves an entry closer
 * to destruction, never further. Read budgets only decrement. Claims
 * only resolve. Expiry only arrives. Nothing can argue an entry back
 * from the brink, because an entry that can be extended is a retention
 * liability, not a stash.
 *
 * @section What this rules out
 *   There is no `touch()`, no TTL extension, no metadata update.
 *   Mutable expiry is the right call for a cache -- cache entries are
 *   hints -- and the wrong call here, where an entry's terms are a
 *   promise made at `push` time. New terms mean a new push. The rule
 *   also decides future features on sight: anything that would let an
 *   entry outlive its terms is rejected.
 *
 * @section Rejection over eviction
 *   The same posture governs capacity. A cache evicts the oldest entry
 *   to make room; a stash that did so would turn a push flood into an
 *   attack on other people's data. When full, `push` fails loudly with
 *   `StashFull` -- the rejection is the feature, because stash entries
 *   are promises, not hints.
 */

/**
 * @concept pop-claim-stream-commit
 * @title   Pop: claim, stream, commit
 * @order   30
 * @related stash.apply, stash.drop, stash.Stash
 *
 * A naive destructive read deletes the entry and then streams the file;
 * when the connection drops at 60%, the data is gone forever and the
 * reader got half a file. `pop` -- specified in SPEC.md 6 and shipping
 * at milestone M5 -- is therefore a claim, stream, commit cycle, so a
 * failed read never destroys data by default.
 *
 * @section The three steps
 *   Claim: atomically move the entry to a claimed state, so two
 *   concurrent pops race on the rename and exactly one wins -- the loser
 *   gets `RefClaimed`, enforced by the filesystem rather than an
 *   in-process lock. Stream: read from the claimed path, verifying the
 *   digest incrementally. Commit: only when the stream fully drains and
 *   the digest matches does the delete happen.
 *
 * @section When the read fails
 *   A stream error, a premature destroy, or a digest mismatch applies
 *   the `onPopFailure` policy. The default, `restore`, renames the entry
 *   back so the read can be retried -- losing data by default is
 *   hostile. The opt-in alternative, `burn`, deletes anyway: for the
 *   paranoid drop that must assume any read attempt means the bytes were
 *   observed.
 *
 * @section Crash recovery
 *   A process that dies mid-pop leaves a claimed entry orphaned. On the
 *   first operation after construction, claims older than the claim
 *   timeout are found and resolved per the same `onPopFailure` policy --
 *   lazily, because constructors do not do I/O.
 */

/**
 * @concept permission-model
 * @title   The permission-model posture
 * @order   40
 * @related stash.Stash, stash.backends.MemoryBackend
 *
 * StashJS is designed to run cleanly under the Node permission model:
 * `node --permission --allow-fs-read=./.stash/* --allow-fs-write=./.stash/*`.
 * The process holding the blobs is locked to the directory holding the
 * blobs and nothing else -- a compromised dependency elsewhere in the
 * consumer's tree cannot read the stash, and the stash cannot read
 * anything else. It is the store's crypto-agnostic argument enforced by
 * the runtime instead of by discipline.
 *
 * @section What the library gives up for it
 *   No child processes, no worker threads, no native addons, no WASI --
 *   each would need its own grant and each widens the sandbox. No file
 *   descriptors as inputs, ever: existing fds bypass the model, so the
 *   API accepts paths only. And no `node:sqlite` index, even though it
 *   is a builtin: the permission model does not gate filesystem access
 *   made through it, so the one builtin that could plausibly earn its
 *   way in is the one that would quietly disable the sandbox.
 *
 * @section What the sandbox does not do
 *   The permission model follows symlinks out of granted paths, so the
 *   grant alone does not confine a store whose root has been seeded with
 *   a planted link -- containment stays the disk backend's own job,
 *   asserting every resolved path is still under the store root. And
 *   `--permission` does not gate the network: the actual guarantee is
 *   that StashJS opens no sockets at all.
 *
 * @section Fail loudly when the grant is wrong
 *   The library never probes `process.permission.has()` to branch
 *   behavior. If the grant is wrong, the `ERR_ACCESS_DENIED` surfaces --
 *   a library that silently degrades when sandboxed is worse than one
 *   that fails loudly.
 */

export {};
