// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// CommonJS consumption is supported surface, not an accident: a CJS caller
// can require() the ESM package main and both backend subpaths on the
// 24.18.0 floor (Node's require(esm), since the graph has no top-level await
// and its only non-JS import is a synchronous JSON module). This pins it, so
// a future change that would break it -- introducing top-level await, say --
// fails here loudly instead of silently stranding CJS consumers.
//
// The proof is the fixture (test/fixtures/cjs-consumer.cjs) run the way a
// consumer runs it: SPAWN the real node binary on the .cjs entry and assert
// it exits 0 with its success marker. Spawning skips under the sandbox
// (--permission denies spawn) -- it is the library that must pass sandboxed,
// not the spawning scaffold. Always spawn process.execPath on the file,
// never a bare `npm`/shim arg array (a Windows .cmd).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SANDBOXED } from "./_helpers.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cjs-consumer.cjs");

test("a CommonJS consumer can require() the package and both backend subpaths", { skip: SANDBOXED }, () => {
  const r = spawnSync(process.execPath, [FIXTURE], { encoding: "utf8", env: { ...process.env } });
  assert.equal(r.status, 0, "the CJS fixture exits 0 (stderr: " + (r.stderr || "") + ")");
  assert.match(r.stdout, /CJS-OK/, "the fixture reports its success marker");
});
