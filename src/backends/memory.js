// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
/**
 * @module     stash.backends
 * @nav        Backends
 * @title      Backends
 * @order      20
 * @slug       backends
 *
 * @intro
 *   The storage layer, behind one contract (SPEC.md 9): the backend holds
 *   bytes; `Stash` holds policy. A backend never validates lifecycle,
 *   never interprets `meta`, and never decides destruction -- it stores
 *   what it is handed under the id it is handed, computes size and sha256
 *   digest as the bytes stream through, and reports what it holds. The
 *   same conformance suite runs against every backend, unmodified.
 *
 *   Two implementations ship. The memory backend is Map-backed -- no
 *   persistence, no pretense; for tests and legitimately process-lifetime
 *   stashes. The disk backend is sidecar-file storage: one blob and one
 *   JSON sidecar per entry, no central index to corrupt, atomic
 *   tmp-fsync-rename writes, 0700/0600 modes, and realpath containment
 *   that refuses a planted symlink instead of following it.
 *
 * @card
 *   The storage contract and both shipped backends -- Map-backed memory,
 *   and sidecar-file disk with atomic writes and realpath containment.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { spend } from "../entry.js";
import { IntegrityError, RefClaimed, RefNotFound } from "../errors.js";
import { constantTimeEqual } from "../ref.js";

/**
 * @primitive  stash.backends.MemoryBackend
 * @signature  new MemoryBackend() -> MemoryBackend
 * @since      0.1.0
 * @status     experimental
 * @spec       SPEC.md 9
 * @related    stash.Stash
 *
 * Construct the in-memory backend. Pass it as `backend` to `new Stash()`.
 * Storage is a private Map from id to `{ entry, chunks }`; nothing touches
 * the filesystem, so the permission-model posture costs nothing here.
 *
 * @example
 *   import { Stash } from "@blamejs/stash";
 *   import { MemoryBackend } from "@blamejs/stash/backends/memory";
 *
 *   const stash = new Stash({ backend: new MemoryBackend() });
 *   const ref = await stash.push("hello");
 */
export class MemoryBackend {
  #entries = new Map();
  // Claimed entries: id -> { entry, chunks, claimedAt }. A claim moves an entry
  // OUT of #entries into #claims, mirroring the disk backend's blobs/ -> claims/
  // rename. The move is synchronous within one method body -- no await between
  // the check and the move -- so on this single-threaded backend that IS the
  // atomicity two concurrent pops race on: the first move wins, the second sees
  // the id already claimed. A backend never interprets expiry or budgets; it
  // holds bytes and moves them between states the policy layer directs.
  #claims = new Map();

  // write(id, source, entry) -> Entry. Consumes the async-iterable source
  // chunk by chunk, computing size and sha256 digest as bytes pass. Every
  // retained chunk is an OWNED COPY: the store outlives the push, so a
  // caller that reuses its chunk buffer after a yield (a scratch buffer, a
  // pooled slab) must not be able to rewrite stored bytes out from under
  // the recorded digest.
  async write(id, source, entry) {
    const hash = createHash("sha256");
    const chunks = [];
    let size = 0;
    for await (const chunk of source) {
      const buf = chunk instanceof Uint8Array ? Buffer.copyBytesFrom(chunk) : Buffer.from(chunk);
      hash.update(buf);
      size += buf.length;
      chunks.push(buf);
    }
    const stored = structuredClone(entry);
    stored.size = size;
    stored.digest = "sha256:" + hash.digest("hex");
    this.#entries.set(id, { entry: stored, chunks });
    return structuredClone(stored);
  }

  // read(id) -> Readable over the stored chunks. A claimed entry is being popped
  // by someone else: its bytes have moved to #claims, so a normal reader gets
  // RefClaimed, not RefNotFound -- the entry is not gone, it is being served
  // elsewhere (the analogue of the disk backend's blob-in-claims/ state).
  async read(id) {
    if (this.#claims.has(id)) throw new RefClaimed();
    const held = this.#entries.get(id);
    if (held === undefined) throw new RefNotFound();
    return Readable.from(held.chunks.map((buf) => Buffer.from(buf)));
  }

  // remove(id) -> boolean. Destruction is monotone (SPEC.md 4.2): a drop removes
  // the entry whether it is live OR claimed. Dropping a claimed entry destroys
  // it outright -- a later restore of that claim must find nothing and MUST NOT
  // resurrect it. False only when the id is in neither map.
  async remove(id) {
    const wasLive = this.#entries.delete(id);
    const wasClaimed = this.#claims.delete(id);
    return wasLive || wasClaimed;
  }

  // stat(id) -> Entry (a defensive copy). A claimed entry still exists -- its
  // metadata is intact (the disk analogue: the sidecar stays in meta/ while only
  // the blob moves to claims/) -- so a query resolves it from either map.
  async stat(id) {
    const held = this.#entries.get(id) || this.#claims.get(id);
    if (held === undefined) throw new RefNotFound();
    return structuredClone(held.entry);
  }

  // list() -> Entry[] (defensive copies). A claimed entry is mid-pop, not gone,
  // so it appears in the listing until its claim commits -- matching the disk
  // backend, whose sidecar stays in meta/ across a claim.
  async list() {
    const out = [];
    for (const held of this.#entries.values()) out.push(structuredClone(held.entry));
    for (const held of this.#claims.values()) out.push(structuredClone(held.entry));
    return out;
  }

  // claim(id) -> { entry, source }. Atomically move the entry from live to
  // claimed and hand back its metadata plus a fresh Readable over its bytes. The
  // move is the atomicity: no await precedes it, so two concurrent claims cannot
  // both win -- the second sees the id already in #claims and gets RefClaimed.
  // The source reads from the SNAPSHOT taken here, so restoring or committing the
  // claim never disturbs an in-flight read.
  async claim(id) {
    if (this.#claims.has(id)) throw new RefClaimed();
    const held = this.#entries.get(id);
    if (held === undefined) throw new RefNotFound();
    this.#entries.delete(id);
    this.#claims.set(id, { entry: held.entry, chunks: held.chunks, claimedAt: Date.now() });
    return {
      entry: structuredClone(held.entry),
      source: Readable.from(held.chunks.map((buf) => Buffer.from(buf))),
    };
  }

  // restore(id) -> void. Return a claimed entry to the live map under its
  // original terms. An occupied live slot is impossible for a unique-minted id
  // and would mean a drop/claim interleaving resurrecting destroyed data
  // (SPEC.md 4.2) -- corruption, refused rather than silently overwritten.
  async restore(id) {
    const held = this.#claims.get(id);
    if (held === undefined) throw new RefNotFound();
    if (this.#entries.has(id)) throw new IntegrityError("restore target is occupied");
    this.#claims.delete(id);
    this.#entries.set(id, { entry: held.entry, chunks: held.chunks });
  }

  // commit(id) -> void. Destroy a claimed entry -- the terminal half of pop and
  // of a budget-exhausting read. Only ever called while holding the claim.
  async commit(id) {
    if (!this.#claims.delete(id)) throw new RefNotFound();
  }

  // listClaims() -> { id, claimedAt }[]. The recovery scan reads this to resolve
  // claims a prior run abandoned; no operator-facing claim inspection ships in M5.
  async listClaims() {
    const out = [];
    for (const [id, held] of this.#claims) out.push({ id, claimedAt: held.claimedAt });
    return out;
  }

  // isClaimed(id) -> boolean. Advisory: is a live claim held on this id right now?
  // apply/pop probe this before their advisory stat, so a contended reader rejects
  // RefClaimed WITHOUT touching the entry's mutable state -- on disk that state is
  // the sidecar the claim-holder rewrites, and an open reader would block that
  // rewrite. Recovery resolves stale claims before the probe, so a hit is live.
  async isClaimed(id) {
    return this.#claims.has(id);
  }

  // consumeRead(id) -> remaining. Debit one read credit from a CLAIMED entry and
  // return what is left. Routed through entry.spend so the decrement lives at the
  // schema home, never hand-rolled here (the guard-shape tripwire). The decrement
  // rides on the claim, so it persists across a subsequent restore. Only ever
  // called while holding the claim -- the claim is the cross-reader mutex.
  async consumeRead(id) {
    const held = this.#claims.get(id);
    if (held === undefined) throw new RefNotFound();
    held.entry = spend(held.entry);
    return held.entry.readsLeft;
  }

  // stats() -> { entries, bytes, claimed }. The stash-wide limit pre-check reads
  // this aggregate rather than parsing every entry: `entries` counts every stored
  // entry, live OR claimed (a claimed blob still occupies the store), `bytes` the
  // stored footprint, `claimed` the number mid-pop. `bytes` sums each entry's
  // blob size AND its metadata, so a limit sees the real cost -- a caller can't
  // slip past `maxTotal` by pushing tiny blobs with huge `meta`. Counts every
  // stored entry, expired or not -- a backend never interprets expiry; the policy
  // layer prunes before it rejects.
  async stats() {
    let bytes = 0;
    let entries = 0;
    for (const held of this.#entries.values()) {
      bytes += held.entry.size + Buffer.byteLength(JSON.stringify(held.entry));
      entries += 1;
    }
    for (const held of this.#claims.values()) {
      bytes += held.entry.size + Buffer.byteLength(JSON.stringify(held.entry));
      entries += 1;
    }
    return { entries, bytes, claimed: this.#claims.size };
  }

  // verify(opts) -> Report. Digest-check every held entry against its stored
  // digest. A Map has no orphan halves, no corrupt sidecars, and no in-flight
  // .tmp by construction, so those finding kinds are structurally empty here --
  // the report SHAPE matches the disk backend's. A claimed entry (mid-pop) still
  // occupies the store and is COUNTED in `scanned` -- disk counts its sidecar in
  // meta/, so both backends report the same scanned total for one logical store
  // (cross-backend parity) -- but its digest is not re-checked here, matching
  // disk's walk, which skips a blob that lives under claims/. A stale claim (older
  // than the lease) is REPORTED, never repaired (resolving it is crash recovery's
  // job). Repair removes only a digest-mismatched entry -- its chunks and metadata
  // go together, and healthy entries survive untouched.
  async verify(opts) {
    const findings = [];
    const repaired = [];
    let scanned = 0;
    for (const [id, held] of this.#entries) {
      scanned += 1;
      const hash = createHash("sha256");
      for (const buf of held.chunks) hash.update(buf);
      if (!constantTimeEqual("sha256:" + hash.digest("hex"), held.entry.digest)) {
        findings.push({ kind: "digest-mismatch", id });
        if (opts.repair) {
          this.#entries.delete(id);
          repaired.push({ kind: "digest-mismatch", id });
        }
      }
    }
    const now = Date.now();
    for (const [id, held] of this.#claims) {
      scanned += 1; // a claimed blob still occupies the store; disk counts its meta/ sidecar, so match
      if (now - held.claimedAt >= opts.claimTimeoutMs) findings.push({ kind: "stale-claim", id });
    }
    return { scanned, findings, repaired };
  }
}
