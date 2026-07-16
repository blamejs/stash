// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// SPEC.md 13.1 invariant 2: the full suite passes under --permission with
// filesystem grants scoped to the repository (read) and the test scratch
// root (write). A change that quietly needs a broader grant fails here, at
// the moment it is made.
//
// --test-isolation=none runs every test file in-process: the permission
// model denies child-process spawn, which is exactly the posture the
// library itself must hold (it never spawns), so the runner adapts, not
// the grants. This launcher is dev tooling and may spawn; src/ may not.
//
// Scope: the library suite under test/. The wiki example app is excluded
// deliberately -- it binds an HTTP listener, and Node lines newer than 24
// gate the network under --permission; the invariant here is that the
// LIBRARY never needs a grant beyond its storage root.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = join(ROOT, ".test-stash");
mkdirSync(SCRATCH, { recursive: true });

const result = spawnSync(
  process.execPath,
  [
    "--permission",
    "--allow-fs-read=" + ROOT,
    "--allow-fs-write=" + SCRATCH,
    "--test",
    "--test-isolation=none",
    "test/*.test.js",
  ],
  { cwd: ROOT, stdio: "inherit" }
);

process.exit(result.status === null ? 2 : result.status);
