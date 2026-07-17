// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Run StashJS under the Node permission model, with filesystem grants scoped
// to the store and nothing else.
//
//   node examples/permission-flags.js
//
// StashJS is designed to run with a filesystem grant no wider than its own
// storage root: it never spawns a child, never starts a worker, never opens a
// socket, and never accepts a file descriptor, so no broader capability is ever
// needed. A compromised dependency elsewhere in your tree cannot read the
// stash, and StashJS cannot read anything else.
//
// This example proves it, not just documents it. Launched without the flags, it
// RE-EXECS itself with them (scoped to a throwaway stash root) and then, inside
// the sandbox, shows two things: a stash write to the granted root SUCCEEDS, and
// a write to a path OUTSIDE the grant is DENIED by the runtime. If the denial
// ever stopped happening, this example would fail -- a fail-closed doc.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Sandboxed child: process.permission is live. Do the real demonstration.
// ---------------------------------------------------------------------------
if (typeof process.permission !== "undefined") {
  const { Stash } = await import("@blamejs/stash");
  const { DiskBackend } = await import("@blamejs/stash/backends/disk");

  const stashRoot = process.env.STASH_ROOT;
  const forbidden = process.env.FORBIDDEN_DIR;

  // 1. A stash rooted in the granted directory works -- push and pop round-trip.
  const stash = new Stash({ backend: new DiskBackend({ root: stashRoot }) });
  const ref = await stash.push("bytes inside the grant");
  const chunks = [];
  for await (const chunk of await stash.pop(ref)) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "bytes inside the grant");
  console.log("  [sandbox] stash push/pop inside the granted root: OK");

  // 2. A write to a path OUTSIDE the grant is refused by the runtime, not by us.
  let denied = false;
  try {
    writeFileSync(join(forbidden, "escaped.txt"), "this must never be written");
  } catch (err) {
    denied = err && err.code === "ERR_ACCESS_DENIED";
  }
  assert.equal(denied, true, "an out-of-scope write must be denied by the permission model");
  console.log("  [sandbox] write outside the grant: DENIED (ERR_ACCESS_DENIED)");

  console.log("\npermission-flags: the grant is exactly the stash root -- nothing wider. OK");
} else {
  // -------------------------------------------------------------------------
  // Top-level launch: no permission model yet. Re-exec self WITH the flags,
  // scoped to a throwaway stash root; the child above runs the demonstration.
  // -------------------------------------------------------------------------
  const stashRoot = join(tmpdir(), "stashjs-perm-" + process.pid);
  const forbidden = join(tmpdir(), "stashjs-perm-forbidden-" + process.pid);
  mkdirSync(stashRoot, { recursive: true });
  mkdirSync(forbidden, { recursive: true });

  // The grant: READ the app (so the library source loads) and the stash root,
  // WRITE only the stash root. The forbidden directory is deliberately absent.
  const flags = [
    "--permission",
    "--allow-fs-read=" + APP_ROOT,
    "--allow-fs-read=" + stashRoot,
    "--allow-fs-write=" + stashRoot,
  ];
  console.log("Re-running under the Node permission model:");
  console.log("  node \\\n    " + flags.join(" \\\n    ") + " \\\n    examples/permission-flags.js\n");

  try {
    const result = spawnSync(process.execPath, [...flags, fileURLToPath(import.meta.url)], {
      cwd: APP_ROOT,
      stdio: "inherit",
      env: { ...process.env, STASH_ROOT: stashRoot, FORBIDDEN_DIR: forbidden },
    });
    process.exitCode = result.status === null ? 2 : result.status;
  } finally {
    rmSync(stashRoot, { recursive: true, force: true });
    rmSync(forbidden, { recursive: true, force: true });
  }
}
