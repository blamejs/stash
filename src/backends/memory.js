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

import { RefNotFound } from "../errors.js";

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

  // write(id, source, entry) -> Entry. Consumes the async-iterable source
  // chunk by chunk, computing size and sha256 digest as bytes pass.
  async write(id, source, entry) {
    const hash = createHash("sha256");
    const chunks = [];
    let size = 0;
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
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

  // read(id) -> Readable over the stored chunks.
  async read(id) {
    const held = this.#entries.get(id);
    if (held === undefined) throw new RefNotFound();
    return Readable.from(held.chunks.map((buf) => Buffer.from(buf)));
  }

  // remove(id) -> boolean. False when the id is absent.
  async remove(id) {
    return this.#entries.delete(id);
  }

  // stat(id) -> Entry (a defensive copy -- entries are write-once).
  async stat(id) {
    const held = this.#entries.get(id);
    if (held === undefined) throw new RefNotFound();
    return structuredClone(held.entry);
  }

  // list() -> Entry[] (defensive copies).
  async list() {
    const out = [];
    for (const held of this.#entries.values()) out.push(structuredClone(held.entry));
    return out;
  }
}
