// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// The ambient state an `@example` in src/ is allowed to assume.
//
// Most @example blocks are one or two lines -- `await stash.drop(ref)` -- because
// burying the verb under six lines of setup would hide the thing being
// documented. That shorthand only works if "a stash" and "a ref" mean something
// concrete, so this module IS the definition: it builds the small world the docs
// are written against, and scripts/run-doc-examples.js executes every @example
// inside it. An example that reaches for an identifier this module does not
// define fails that gate, so the shorthand can never quietly become fiction.
//
// The world is rebuilt from scratch for every example. Examples destroy things
// (`pop`, `drop`, `clear`), and each one must see the same starting state
// regardless of what ran before it.
//
// What each binding means, and why it exists:
//
//   stash       a live store over MemoryBackend with a '24h' default expiry
//   ref         a live ref into `stash` -- the entry `ciphertext` was pushed as
//   ciphertext  the bytes a caller pushes (the store never inspects them; the
//               name is the docs' reminder that encryption is the consumer's layer)
//   data        bytes for an example that pushes something other than `ciphertext`
//   sink        a write target for a drained stream: `sink.write(chunk)` collects
//               into `sink.chunks`
//   backend     a fresh, unused backend for an example that constructs its own Stash
//   primary     a store holding three entries, one of them already destroyed, so a
//               replication example has both live entries and a tombstone to walk
//   replica     an empty store to replicate INTO
//   from, to    the same pair under the names the reconcilation examples use
//   bytesFor    the blob bytes behind an id in `primary`, so a `store()` example
//               can supply bytes that match the entry's digest
//
// Imports src/ directly rather than by package name: the examples themselves
// resolve `@blamejs/stash` through the package's exports map, and that check is
// theirs to fail, not this module's to blur.

import { Stash } from "../src/index.js";
import { MemoryBackend } from "../src/backends/memory.js";

// The binding names an @example may use without declaring them. Exported so the
// runner injects exactly this set and a drift between the two is a test failure
// rather than a silently missing identifier.
export const WORLD_KEYS = Object.freeze([
  "stash",
  "ref",
  "ciphertext",
  "data",
  "sink",
  "backend",
  "primary",
  "replica",
  "from",
  "to",
  "bytesFor",
]);

// makeWorld() -> { bindings, close } -- one disposable world.
//
// `bindings` holds exactly WORLD_KEYS. `close()` shuts down every Stash it
// opened, per store and best-effort: it runs in a `finally` after the example,
// so a fault raised while tearing the world down would replace the example's own
// error with one about the harness -- the diagnostic the gate exists to deliver,
// lost to the cleanup behind it.
export async function makeWorld() {
  const stash = new Stash({ backend: new MemoryBackend(), ttl: "24h" });
  const ciphertext = Buffer.from("bytes the store never looks inside");
  const data = Buffer.from("a second payload");
  const ref = await stash.push(ciphertext, { meta: { kind: "drop" } });

  // A plain collector rather than a real Writable: the drain examples only ever
  // call `.write(chunk)`, and a stream would add a lifecycle the example does
  // not close and the gate would then have to unwind.
  const sink = {
    chunks: [],
    write(chunk) {
      this.chunks.push(chunk);
      return true;
    },
  };

  const backend = new MemoryBackend();

  const primary = new Stash({ backend: new MemoryBackend() });
  const replica = new Stash({ backend: new MemoryBackend() });
  const blobs = new Map();
  for (const label of ["alpha", "beta", "gamma"]) {
    const payload = Buffer.from("replicated-" + label);
    blobs.set(await primary.push(payload, { meta: { label } }), payload);
  }
  // One destruction up front, so a `tombstones()` example has a grave to walk and
  // its loop body actually executes. An empty listing would let the example pass
  // without running a line of what it documents.
  const [doomed] = await primary.list();
  await primary.drop(doomed.id);

  const stores = [stash, primary, replica];

  return {
    bindings: {
      stash,
      ref,
      ciphertext,
      data,
      sink,
      backend,
      primary,
      replica,
      // The reconciliation examples name the same pair `from` and `to`; aliasing
      // keeps `bytesFor` correct for both spellings.
      from: primary,
      to: replica,
      bytesFor: (id) => blobs.get(id),
    },
    async close() {
      for (const store of stores) {
        try {
          await store.close();
        } catch {
          /* teardown must not mask the example's own verdict */
        }
      }
    },
  };
}
