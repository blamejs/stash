# Threat model

`@blamejs/stash` holds bytes other systems consider sensitive -- its first
consumer stores encrypted uploads for scenarios up to and including a
whistleblower drop. The store itself never sees plaintext and never holds a
key, but it does hold the capabilities that gate access, the promise that a
popped entry is gone, and (with the disk backend) a directory an attacker
would love to escape. This document states what the library defends, where
the trust boundaries are, the threat classes it is designed against, and
what is explicitly out of scope.

**Implementation status matters here.** The library is mid-build: milestone
M1 (the memory backend and the `push` / `apply` / `show` / `list` / `drop` /
`clear` verbs) is implemented; milestones M2-M8 are specified in
[SPEC.md](SPEC.md) section 12 and not yet built. Each defense below is
marked accordingly. A defense marked *specified* is a design commitment the
implementation must meet, not shipped code.

## Assets

- **Ref confidentiality** -- a ref is a capability. Whoever holds it can
  read (and destroy) the entry; nobody without it can. The ref must be
  unguessable, unenumerable, and must not leak through errors or logs.
- **The destruction guarantee** -- a popped, dropped, expired, or
  budget-spent entry must actually be gone, and must stay gone (including
  across replicas).
- **Entry integrity and survival** -- bytes read out are the bytes pushed
  in; a failed read must not silently destroy data; a full store must not
  silently destroy other entries to make room.
- **Containment** -- the store's filesystem footprint is its root directory
  and nothing else, even against hostile refs and planted symlinks.

## Trust boundaries

| Input | Trust | Handling |
|---|---|---|
| Refs arriving at any public method | **Untrusted** | Whitelist regex (`/^v1_[A-Za-z0-9_-]{43}$/`) before anything else; `InvalidRef` otherwise -- *implemented (M1)* |
| Blob bytes (`push` sources) | **Untrusted, opaque** | Never interpreted, sniffed, or inspected; size-limited mid-stream -- *limits specified (M4)* |
| `meta` values | **Untrusted, opaque** | Round-tripped verbatim; never read, validated, indexed, or logged -- *implemented (M1)* |
| Replication input (`store()` entries) | **Untrusted** | Full check order of SPEC.md section 4.4: ref whitelist, tombstone refusal, expiry no-op, idempotency, digest-conflict rejection -- *specified (M7)* |
| The filesystem under the stash root | **Semi-trusted** | Realpath containment, `lstat` symlink rejection, digest verification -- *specified (M2/M5/M6)* |
| Constructor options (backend, TTL, limits, policies) | **Operator-provided (trusted)** | Taken as configuration |

## Threat classes and design response

1. **Compelled-operator disclosure.** Someone with legal or physical
   leverage over the operator demands the contents. -> The store cannot
   decrypt anything: there is no key parameter on any method, no cipher
   import anywhere in the source tree, no `decrypt` option. A store that
   *chooses* not to decrypt is a promise; a store with nowhere for a key to
   live is an architecture, and only the second survives compulsion.
   Encryption belongs to the consumer, which is the thing with the key.
   *Architectural; in force since M1 and enforced by an executable
   invariant (the source greps clean of `createCipheriv` /
   `createDecipheriv`; SPEC.md section 13.1).*

2. **Ref guessing and enumeration.** An attacker probes for entries they
   suspect exist. -> Refs are 256-bit random values, not content hashes --
   a content hash is guessable by anyone holding the content, which would
   make the store an enumeration oracle for "did someone stash this
   document." The digest is integrity-only and never accepted as a lookup
   key. Ref comparison uses `timingSafeEqual` so a comparison cannot leak
   prefix matches. *Implemented (M1).*

3. **Path traversal via refs.** Refs become filenames, so a hostile ref is
   a hostile path. -> Every ref entering a public method must match the
   whitelist regex character-for-character before it touches the
   filesystem; `../../etc/shadow` dies at the regex, not at the syscall.
   No normalization, no `path.resolve` rescue, no clean-it-up-and-continue.
   *Validation implemented (M1); the disk paths it defends arrive with the
   DiskBackend (M2).*

4. **Symlink escape from the stash root.** Something plants a symlink
   inside the root pointing outside it. -> Node's permission model follows
   symlinks out of granted paths, so containment is the library's job, not
   the sandbox's: the DiskBackend realpaths its root at construction,
   asserts every resolved blob/meta/claim path is still under that root
   (refusing with `InvalidRef` otherwise), and uses `lstat` rather than
   `stat` so a symlink where a blob should be reads as corruption, not a
   blob. *Specified for the DiskBackend (M2); not yet built.*

5. **Push flood / disk fill.** An attacker (or a curl loop) pushes until
   the disk is full. -> `maxSize` is enforced mid-stream (the write is
   destroyed and the partial cleaned up the moment the limit is crossed --
   never write-then-check), and `maxEntries` / `maxTotal` reject with
   `StashFull`. There is **no eviction**: silently destroying the oldest
   entry to make room would turn a push flood into an attack on other
   people's data -- for a whistleblower drop, a denial-of-evidence
   primitive. The loud rejection is the feature. *Limits specified (M4);
   not yet built. No-eviction is a standing design rule (SPEC.md
   section 3).*

6. **Partial-read data loss.** A destructive read's connection drops at
   60% and the bytes are gone while the reader got half a file. -> `pop`
   is a claim -> stream -> commit cycle: the delete happens only after a
   full drain with a matching digest, and a failed read applies the
   `onPopFailure` policy -- `'restore'` by default (the entry survives for
   retry; losing data by default is hostile), `'burn'` as an explicit
   opt-in for stores that treat any read attempt as observation. Claims
   orphaned by a crash are recovered per the same policy. *Specified (M5);
   `pop` does not ship yet -- M1's verb set has no destructive read except
   `drop` / `clear`, which read nothing.*

7. **Capability leakage through errors, logs, and telemetry.** A ref in a
   log file is a leaked capability. -> No error message ever contains a
   ref, a `meta` value, or a path (errors carry stable `.code` values
   instead); the library itself logs nothing and phones nothing home; the
   `stats()` surface returns aggregates only, never refs. Event payloads
   carry full entries by design -- the embedder owns the store -- and the
   no-refs-in-logs rule binds what the embedder writes out. *Typed errors
   with the no-identifier rule implemented (M1); the logging and telemetry
   prohibitions are standing design rules (SPEC.md sections 3 and 10).*

8. **Replication resurrection.** Naive sync copies a popped entry straight
   back from a replica that still holds it -- the dead walk. -> Every early
   destruction (`pop`, `drop`, `clear`, a spent read budget) writes a
   tombstone recording only `{ id, destroyedAt, cause }` -- no digest, no
   size, no `meta`, because a tombstone that describes the body defeats the
   burial. `store()` refuses a tombstoned id outright and no-ops an entry
   whose expiry has already passed, so destruction is monotone across
   replicas. The residual risk is documented rather than hidden: tombstones
   are pruned after `tombstoneTtl`, and that TTL must exceed the longest
   gap between reconciliations -- a knob only the deployment can set. And a
   read budget is enforced per store, so multi-replica serving degrades
   exactly-once to eventually-once; the spec directs consumers to a
   cold-standby topology if they need the stronger guarantee. *Specified
   (M7); not yet built.*

9. **Silent corruption.** Bit rot or a tampered blob served as good bytes.
   -> A digest is computed during the write stream, verified incrementally
   on read, and a mismatch is a loud `IntegrityError`, never silent bad
   bytes; `verify()` audits the whole store for corrupt blobs, orphaned
   halves, and stale claims, and removes nothing without an explicit
   `repair: true`. *Specified (M2 digest-on-write, M5 verify-on-read,
   M6 audit); not yet built.*

As defense-in-depth around all of the above, the library is designed to run
under Node's permission model with filesystem grants scoped to the stash
root (SPEC.md section 2.1) -- no child processes, worker threads, native
addons, or WASI; paths only, never file descriptors; fail loud on
`ERR_ACCESS_DENIED` rather than silently degrading. The suite passing under
`--permission` scoped to the test root is a CI gate from M2 onward. Note
that `--permission` does not gate the network on this Node line; the store
opens no sockets regardless, which is the actual guarantee.

## Out of scope

- **Plaintext confidentiality.** The store holds opaque bytes and cannot
  decrypt them -- but it also cannot encrypt them. If the bytes arrive as
  plaintext, they sit on disk as plaintext. Encryption is the consumer's
  layer, by design.
- **An attacker with the operator's privileges.** File modes (`0600` /
  `0700`) and the permission-model posture raise the bar, but an attacker
  running as root or as the stash-owning user reads the blobs. This is
  precisely why the payload should arrive encrypted.
- **Access control beyond ref possession.** A ref is the authorization.
  There are no users, ACLs, or scopes; anyone holding a ref can read and
  destroy that entry.
- **Durability.** The store is ephemeral by design: TTLs, read budgets, and
  `pop` destroy data on purpose, and there is no backup mechanism. It is
  not an archive.
- **Transport security.** The library opens no sockets; protecting bytes
  and refs in flight -- including the replication transport -- is the
  consumer's responsibility.
- **Memory forensics and swap.** Bytes stream through process memory;
  defending a compromised or memory-captured host is out of scope.

## Reporting

Security issues are reported privately via GitHub's
["Report a vulnerability"](https://github.com/blamejs/stash/security/advisories/new)
advisory form -- never through a public issue.
