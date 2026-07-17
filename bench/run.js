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

// Invoked directly: run the full bench and print it as one JSON document.
if (process.argv[1] && process.argv[1].endsWith("run.js")) {
  bench()
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    })
    .catch((err) => {
      process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
      process.exit(1);
    });
}
