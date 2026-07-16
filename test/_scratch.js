// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// The one definition of where disk-backed tests put their stash roots:
// under the OS temp dir, NOT inside the repository -- a checkout under a
// file-sync service (or a watching AV) holds transient handles on fresh
// files, which turns in-repo cleanup into flaky EPERMs. The sandboxed
// runner imports the same constant so its --allow-fs grants and the
// tests' writes can never drift apart.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared base for every test process; per-process subdirs keep parallel
// test files isolated while the sandbox grants cover them all.
export const SCRATCH_BASE = join(tmpdir(), "stashjs-tests");

let _counter = 0;
const _created = [];

// freshScratchDir(prefix) -> a unique directory path for one stash root.
// Created lazily by the backend; tracked for end-of-run removal.
export function freshScratchDir(prefix) {
  _counter += 1;
  const dir = join(SCRATCH_BASE, prefix + "-" + process.pid + "-" + _counter);
  _created.push(dir);
  return dir;
}

// ensureBase() -- the sandboxed runner calls this BEFORE granting, so the
// grant target exists; tests call it implicitly via cleanup registration.
export function ensureBase() {
  mkdirSync(SCRATCH_BASE, { recursive: true });
  return SCRATCH_BASE;
}

// cleanupScratch() -- remove everything this process created. Retries
// cover slow temp-dir scanners; failures here are loud, not swallowed.
export function cleanupScratch() {
  for (const dir of _created) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  _created.length = 0;
}
