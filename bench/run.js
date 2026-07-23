// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// @internal -- no operator-facing namespace; never packs (bench/ is INTERNAL_ONLY).
//
// A zero-dependency throughput/latency harness for the store's hot paths, measured
// with node:perf_hooks across the axes the store actually varies on: both backends,
// each integrity digest (M9 made the algorithm a real perf axis), and a couple of
// payload sizes composed from C.BYTES. It measures push, apply (a re-read of an
// unbudgeted entry -- no credit spent), and pop (each destroys, so a fresh push is
// excluded from the timing). Output is a stable JSON document so a future
// baseline-diff is cheap. Report-only: no throughput floor is asserted anywhere --
// machine variance makes a hard threshold meaningless. `bench()` is exported for the
// smoke proof; invoked directly it prints the full run as JSON.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";

import { C } from "../src/constants.js";
import { DIGESTS } from "../src/digest.js";
import { MemoryBackend } from "../src/backends/memory.js";
import { DiskBackend } from "../src/backends/disk.js";
import { Stash } from "../src/index.js";

const ALGOS = Object.keys(DIGESTS);

async function drain(readable) {
  let bytes = 0;
  for await (const chunk of readable) bytes += chunk.length;
  return bytes;
}

// A streamed source of `size` bytes in 16 KiB chunks -- the bench must exercise the
// SAME streaming path it claims to measure, never a single pre-built buffer.
function streamOf(size) {
  const chunk = Buffer.alloc(Math.min(size, 16 * C.BYTES.KIB), 0x61);
  let remaining = size;
  return new Readable({
    read() {
      if (remaining <= 0) return this.push(null);
      const n = Math.min(chunk.length, remaining);
      remaining -= n;
      this.push(n === chunk.length ? chunk : chunk.subarray(0, n));
    },
  });
}

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx];
}

// summarize(samplesMs, bytesEach) -> the stable per-cell schema.
function summarize(samplesMs, bytesEach) {
  const sorted = samplesMs.slice().sort((a, b) => a - b);
  const totalMs = sorted.reduce((s, x) => s + x, 0);
  const count = sorted.length;
  const opsPerSec = totalMs > 0 ? (count / totalMs) * 1000 : 0;
  return {
    count,
    opsPerSec,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    bytesPerSec: totalMs > 0 ? (count * bytesEach / totalMs) * 1000 : 0,
  };
}

// timed(fn, n) -> latency samples in ms, one per call. `fn(i)` runs the operation.
async function timed(fn, n) {
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    await fn(i);
    samples.push(performance.now() - t0);
  }
  return samples;
}

// bench(opts) -> { generatedAt: null, cells: [...] }. Each cell is one
// backend/algo/size/op measurement. `iterations`/`warmup` are per cell; the warmup
// runs are executed but discarded so JIT/GC settle before timing.
export async function bench({ iterations = 30, warmup = 3, sizes, algos } = {}) {
  const SIZES = sizes || [C.BYTES.KIB, 256 * C.BYTES.KIB];
  const ALGO_SET = algos || ALGOS;
  const roots = [];
  const backends = [
    { name: "memory", make: () => new MemoryBackend() },
    {
      name: "disk",
      make: () => {
        const root = mkdtempSync(join(tmpdir(), "stash-bench-"));
        roots.push(root);
        return new DiskBackend({ root });
      },
    },
  ];
  const cells = [];
  try {
    for (const backend of backends) {
      for (const algo of ALGO_SET) {
        for (const size of SIZES) {
          const stash = new Stash({ backend: backend.make(), digest: algo, sweepInterval: null });
          const label = { backend: backend.name, algo, size };

          // push: a fresh streamed payload each iteration (warmup runs discarded).
          const pushed = [];
          const pushSamples = await timed(async () => {
            const ref = await stash.push(streamOf(size));
            pushed.push(ref);
          }, iterations + warmup);
          cells.push({ ...label, op: "push", ...summarize(pushSamples.slice(warmup), size) });

          // apply: re-read an unbudgeted entry (no credit spent), so one entry serves
          // every iteration; measures the digest-verifying read path.
          const readRef = pushed[pushed.length - 1];
          const applySamples = await timed(async () => {
            await drain(await stash.apply(readRef));
          }, iterations + warmup);
          cells.push({ ...label, op: "apply", ...summarize(applySamples.slice(warmup), size) });

          // pop: destroys, so time only the pop over the entries pushed above (drop
          // the warmup slice of refs); a fresh push is NOT counted in the sample.
          const popRefs = pushed.slice(warmup);
          const popSamples = await timed(async (i) => {
            await drain(await stash.pop(popRefs[i]));
          }, popRefs.length);
          cells.push({ ...label, op: "pop", ...summarize(popSamples, size) });

          await stash.close();
        }
      }
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
  // generatedAt is left null: the caller stamps a timestamp (the harness reads no
  // clock of its own beyond perf_hooks deltas, so a run is reproducible).
  return { generatedAt: null, iterations, warmup, cells };
}

// boundedInsertScaling(opts) -> { generatedAt: null, backend, limit, N, samples }.
// The insert-under-a-bound cost curve. A bounded push/store runs prune() + stats()
// before it writes -- prune() opens and parses every sidecar to reap the dead
// (mandatory: maxTotal charges its residual against the LIVE footprint), stats()
// then totals the physical footprint -- so each insert is O(n) over the store and a
// run of N is O(n^2). This measures per-insert latency as the store grows, so the
// no-central-index tradeoff (SPEC.md 3: the full scan is cheap at maxEntries scale,
// and a count/index to make the gate O(1) is the mutable-file coupling the sidecar
// design rejects) is a number, not a claim. Report-only, like bench(): no floor is
// asserted -- machine variance makes a hard threshold meaningless. Kept out of the
// default run so `node bench/run.js`'s stable JSON is unchanged; pass `--bounded`.
export async function boundedInsertScaling({ N = 500, backendName = "disk", limit = { maxEntries: 1e9 } } = {}) {
  const roots = [];
  const make = backendName === "memory"
    ? () => new MemoryBackend()
    : () => {
      const root = mkdtempSync(join(tmpdir(), "stash-bounded-"));
      roots.push(root);
      return new DiskBackend({ root });
    };
  const blob = Buffer.alloc(64, 0x61); // small blob: the cost is the scan, not the blob IO
  const perInsertMs = new Array(N);
  try {
    // sweepInterval null: no background prune competes with the timed inserts.
    const stash = new Stash({ backend: make(), sweepInterval: null, ...limit });
    for (let i = 0; i < N; i += 1) {
      const t0 = performance.now();
      await stash.push(blob);
      perInsertMs[i] = performance.now() - t0;
    }
    await stash.close();
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
  // Sample per-insert latency at growing store sizes rather than dumping N points.
  const marks = [1, 100, 250, 500, 750, 1000].filter((n) => n <= N);
  const samples = marks.map((at) => ({ at, ms: perInsertMs[at - 1] }));
  return { generatedAt: null, backend: backendName, limit, N, samples };
}

// Invoked directly: the default run prints the hot-path bench as one stable JSON
// document; `--bounded` prints the insert-under-a-bound scaling curve instead.
if (process.argv[1] && process.argv[1].endsWith("run.js")) {
  const runner = process.argv.includes("--bounded")
    ? boundedInsertScaling({ N: 1000 })
    : bench();
  runner
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    })
    .catch((err) => {
      process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
      process.exit(1);
    });
}
