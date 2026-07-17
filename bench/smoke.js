// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// @internal -- the bench harness's correctness proof (modeled on the fuzz
// local-smoke): run bench() at a tiny fixed iteration count and assert every cell
// carries the stable schema with finite, non-negative numbers and at least one
// measured op. This is what wires into the pipeline -- NOT the full perf run, and
// NOT a throughput floor (machine variance makes a hard threshold meaningless).

import assert from "node:assert/strict";

import { bench } from "./run.js";

const SCHEMA_KEYS = ["count", "opsPerSec", "p50", "p95", "p99", "bytesPerSec"];

async function main() {
  const result = await bench({ iterations: 3, warmup: 1, sizes: [1024], algos: ["sha256", "sha3-512"] });
  assert.ok(Array.isArray(result.cells) && result.cells.length > 0, "bench produced cells");
  let checks = 0;
  for (const cell of result.cells) {
    for (const key of ["backend", "algo", "size", "op"]) {
      assert.ok(key in cell, "cell labels its " + key);
    }
    for (const key of SCHEMA_KEYS) {
      assert.ok(Number.isFinite(cell[key]) && cell[key] >= 0, `cell.${key} is finite and non-negative`);
      checks += 1;
    }
    assert.ok(cell.count > 0, "cell measured at least one op");
  }
  // Every op the harness claims to cover appears for at least one cell.
  for (const op of ["push", "apply", "pop"]) {
    assert.ok(result.cells.some((c) => c.op === op), "the harness measured " + op);
  }
  console.log("bench smoke: " + result.cells.length + " cells, " + checks + " numeric checks ok");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
