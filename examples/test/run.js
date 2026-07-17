// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Runs every top-level example under examples/ and asserts it exits 0 with its
// success marker. The examples are documentation that has to keep working, so
// this runs in CI (npm run examples), and drift rule 16 / the no-MVP rule make
// a broken example a failing build.
//
// It lives OUTSIDE the test/*.test.js glob on purpose: the examples spawn a
// child (the permission-flags demo re-execs itself under --permission), which
// the sandboxed suite denies -- exactly as the wiki e2e is excluded for binding
// a socket. Run it directly:
//
//   node examples/test/run.js
//
// Exit 0: every example passed. Exit 1: an example exited non-zero or its
// success marker was missing -- the same signal CI reports.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = resolve(HERE, "..");
const ROOT = resolve(EXAMPLES_DIR, "..");

// Each example must exit 0 and print its final marker line, so a script that
// silently short-circuits before its asserts (an early return, a swallowed
// error) is caught as a missing marker, not a false pass.
const EXAMPLES = [
  { file: "lifecycle.js", marker: "lifecycle: every step asserted" },
  { file: "cold-standby.js", marker: "cold-standby: replicated, destroyed, converged" },
  { file: "permission-flags.js", marker: "permission-flags: nothing in the process can touch the filesystem outside its grant" },
];

let failures = 0;
let checks = 0;

function check(label, ok, detail) {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.error("FAIL  " + label + (detail ? ": " + detail : ""));
}

for (const { file, marker } of EXAMPLES) {
  const result = spawnSync(process.execPath, [join(EXAMPLES_DIR, file)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
  });
  const output = (result.stdout || "") + (result.stderr || "");
  check(file + " exits 0", result.status === 0, "exit " + result.status + (result.stderr ? "\n" + result.stderr : ""));
  check(file + " prints its success marker", output.includes(marker), "marker not found: " + JSON.stringify(marker));
}

if (failures > 0) {
  console.error("\nexamples: " + failures + " of " + checks + " checks failed");
  process.exit(1);
}
console.log("examples: " + checks + " checks ok (" + EXAMPLES.length + " examples ran clean)");
