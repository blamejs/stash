// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// A CommonJS consumer of @blamejs/stash, run by cjs-consumer.test.js. The
// package authors in ESM ("type": "module"), but no source file uses
// top-level await and the only non-JS import is a synchronous JSON module,
// so the whole graph loads under Node's require(esm) (unflagged on the
// 24.18.0 floor). This fixture is the executable proof: it require()s the
// package main and both backend subpaths through the package's own exports
// map (self-reference, since the file sits inside the package), checks the
// surface is intact, and round-trips bytes through the memory backend.
//
// It prints CJS-OK and exits 0 on success; any failure throws (non-zero
// exit) so the spawning test sees a hard verdict, never a false green.

const assert = require("node:assert/strict");

// require() of the ESM package main + both backend subpaths, resolved
// through package.json "exports" exactly as an external CJS consumer would.
const stash = require("@blamejs/stash");
const { MemoryBackend } = require("@blamejs/stash/backends/memory");
const { DiskBackend } = require("@blamejs/stash/backends/disk");

// The public surface is present and typed as an external consumer expects.
assert.equal(typeof stash.Stash, "function", "Stash class is exported");
assert.equal(typeof stash.StashError, "function", "StashError is exported");
assert.equal(typeof stash.RefNotFound, "function", "RefNotFound is exported");
assert.equal(typeof stash.InvalidRef, "function", "InvalidRef is exported");
assert.equal(typeof stash.version, "string", "version is a string");
assert.match(stash.version, /^\d+\.\d+\.\d+/, "version is semver-shaped");
assert.equal(typeof MemoryBackend, "function", "MemoryBackend subpath resolves");
assert.equal(typeof DiskBackend, "function", "DiskBackend subpath resolves");

// A basic push/apply round-trip over the memory backend (no filesystem, so
// this fixture stays sandbox-neutral): bytes in, ref out, same bytes out.
(async () => {
  const s = new stash.Stash({ backend: new MemoryBackend(), sweepInterval: null });
  const ref = await s.push("hello from CJS");
  assert.match(ref, /^v1_/, "push returns a v1_ capability ref");
  const readable = await s.apply(ref);
  const chunks = [];
  for await (const chunk of readable) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "hello from CJS", "apply streams the pushed bytes back");
  await s.close();
  process.stdout.write("CJS-OK\n");
})().catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + "\n");
  process.exit(1);
});
