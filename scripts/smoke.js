// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Smoke pipeline orchestrator.
//
// Run: `npm run smoke` (or `node scripts/smoke.js`)
//
// Stages, in order:
//
//   Static gates (SERIAL, cheapest first -- a failure stops the run):
//     1. node test/codebase-patterns.test.js
//     2. node scripts/validate-source-comment-blocks.js
//     3. node scripts/check-api-snapshot.js
//     4. node scripts/check-status-lifecycle.js
//     5. node scripts/regen-changelog.js --check
//     6. node scripts/check-pack-against-gitignore.js
//
//   Runtime stages (PARALLEL, after every static gate is green):
//     7. node --test          (full suite, wiki e2e included by discovery)
//     8. node scripts/run-sandboxed.js
//     9. node .clusterfuzzlite/local-smoke.js  (fuzz targets load + discriminate)
//
// Every child's full output is persisted to .test-output/smoke.log via
// synchronous fd writes, so a failing run's detail is on disk even if the
// process dies mid-run -- read the log instead of re-running. On failure
// the console shows the failed stage's last 25 lines; the log holds
// everything. This orchestrator is dev tooling and may spawn; src/ may not.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = join(ROOT, ".test-output");
const LOG_PATH = join(OUTPUT_DIR, "smoke.log");

mkdirSync(OUTPUT_DIR, { recursive: true });
try { unlinkSync(LOG_PATH); } catch { /* fresh start */ }
const logFd = openSync(LOG_PATH, "w");

function logWrite(chunk) {
  try {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    writeSync(logFd, buf, 0, buf.length, null);
  } catch { /* best-effort */ }
}

// Tee the orchestrator's own console lines into the log alongside the
// children's output, so the log is a complete transcript of the run.
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, encoding, cb) => { logWrite(chunk); return origStdoutWrite(chunk, encoding, cb); };
process.stderr.write = (chunk, encoding, cb) => { logWrite(chunk); return origStderrWrite(chunk, encoding, cb); };
process.on("exit", () => { try { closeSync(logFd); } catch { /* best-effort */ } });

const STATIC_STAGES = [
  { name: "codebase-patterns", args: ["test/codebase-patterns.test.js"] },
  { name: "comment-blocks", args: ["scripts/validate-source-comment-blocks.js"] },
  { name: "api-snapshot", args: ["scripts/check-api-snapshot.js"] },
  { name: "status-lifecycle", args: ["scripts/check-status-lifecycle.js"] },
  { name: "changelog-regen", args: ["scripts/regen-changelog.js", "--check"] },
  { name: "readme-regen", args: ["scripts/regen-readme.js", "--check"] },
  { name: "pack-gate", args: ["scripts/check-pack-against-gitignore.js"] },
];

const RUNTIME_STAGES = [
  { name: "node-test", args: ["--expose-gc", "--test"] }, // --expose-gc: the guard-reclamation-on-GC vector needs a forced collection
  { name: "sandboxed", args: ["scripts/run-sandboxed.js"] },
  { name: "fuzz-smoke", args: [".clusterfuzzlite/local-smoke.js"] },
  { name: "bench-smoke", args: ["bench/smoke.js"] },
  { name: "examples", args: ["scripts/run-examples.js"] },
];

function runStage(stage) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    logWrite("\n=== stage " + stage.name + ": node " + stage.args.join(" ") + " ===\n");
    const child = spawn(process.execPath, stage.args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const sink = (d) => { out += d.toString(); logWrite(d); };
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    child.on("close", (code) => {
      resolvePromise({ stage, code, ms: Date.now() - started, out });
    });
    child.on("error", (e) => {
      const detail = String((e && e.stack) || e) + "\n";
      logWrite(detail);
      resolvePromise({ stage, code: 1, ms: Date.now() - started, out: out + detail });
    });
  });
}

function reportFailure(result) {
  // The log already holds the stage's full output (streamed above); the
  // console gets the tail so the operator sees the verdict without paging.
  console.error("\nFAIL  " + result.stage.name + "  (exit " + result.code + ", " + result.ms + "ms)");
  console.error("--- last 25 lines (full output: " + LOG_PATH + ") ---");
  console.error(result.out.trim().split("\n").slice(-25).join("\n"));
}

async function main() {
  console.log("@blamejs/stash smoke pipeline");
  console.log("output: " + LOG_PATH);

  const timings = [];

  for (const stage of STATIC_STAGES) {
    const r = await runStage(stage);
    if (r.code !== 0) {
      reportFailure(r);
      process.exit(1);
      return;
    }
    timings.push(r.stage.name + " " + r.ms + "ms");
    console.log("ok  " + r.stage.name + "  (" + r.ms + "ms)");
  }

  console.log("static gates green -- running runtime stages in parallel");
  const runtimeResults = await Promise.all(RUNTIME_STAGES.map(runStage));

  let failed = false;
  for (const r of runtimeResults) {
    if (r.code !== 0) {
      failed = true;
      reportFailure(r);
    } else {
      timings.push(r.stage.name + " " + r.ms + "ms");
      console.log("ok  " + r.stage.name + "  (" + r.ms + "ms)");
    }
  }
  if (failed) {
    process.exit(1);
    return;
  }

  console.log("OK -- " + (STATIC_STAGES.length + RUNTIME_STAGES.length) +
    " stages green (" + timings.join(", ") + ")");
}

main();
