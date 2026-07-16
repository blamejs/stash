// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
/**
 * @module     stash.backends
 * @nav        Backends
 * @title      Memory backend
 * @order      20
 * @slug       backends-memory
 *
 * @intro
 *   The Map-backed reference backend: same interface as the disk backend,
 *   no persistence, no pretense. It exists for tests and for consumers
 *   whose stash is legitimately process-lifetime -- everything vanishes
 *   when the process does.
 *
 *   The backend holds bytes; `Stash` holds policy. A backend never
 *   validates refs, never interprets `meta`, and never decides lifecycle --
 *   it stores what it is handed under the id it is handed, computes size
 *   and digest as the bytes stream through, and reports what it holds.
 *
 * @card
 *   Map-backed storage backend -- the same contract as disk, for tests and
 *   process-lifetime stashes.
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
