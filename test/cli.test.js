// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// The operational CLI (src/cli.js), driven the way an operator drives it: by
// SPAWNING the entry and asserting stdout + exit code. The library is seeded on
// disk first (the CLI reads a real layout), then each subcommand is spawned.
// Every spawning case skips under the sandbox (--permission denies spawn); it is
// the LIBRARY that must pass sandboxed, not the CLI-under-the-suite.

import { after, suite, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Stash } from "../src/index.js";
import { DiskBackend } from "../src/backends/disk.js";
import { COMMAND_NAMES } from "../src/cli.js";
import { freshScratchDir, cleanupScratch } from "./_scratch.js";
import { SANDBOXED } from "./_helpers.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

after(() => cleanupScratch());

// runCli(args, env?) -> { stdout, stderr, status }. Always spawn the real node
// binary on the entry file -- never a bare `npm`/shim arg array (Windows .cmd).
function runCli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status };
}

// seed(fn) -> a disk root a callback populates through the LIBRARY (so the CLI
// reads a genuine on-disk layout). Returns the root path.
async function seed(fn) {
  const root = freshScratchDir("cli");
  const stash = new Stash({ backend: new DiskBackend({ root }), sweepInterval: null });
  await fn(stash);
  await stash.close();
  return root;
}

suite("cli", { skip: SANDBOXED }, () => {
  test("stats --json reports entries/bytes/claimed on a seeded root", async () => {
    const root = await seed(async (s) => {
      await s.push("one");
      await s.push("two");
    });
    const { stdout, status } = runCli(["stats", "--root", root, "--json"]);
    assert.equal(status, 0);
    const stats = JSON.parse(stdout);
    assert.equal(stats.entries, 2);
    assert.equal(stats.claimed, 0);
    assert.ok(stats.bytes > 0);
  });

  test("list shows entries and hides expired unless --include-expired", async () => {
    const refs = {};
    const root = await seed(async (s) => {
      refs.live = await s.push("a live entry");
      refs.gone = await s.push("expires fast", { ttl: 1 });
      await new Promise((r) => setTimeout(r, 10)); // let the short ttl lapse
    });
    const plain = runCli(["list", "--root", root, "--json"]);
    assert.equal(plain.status, 0);
    const shown = JSON.parse(plain.stdout).map((e) => e.id);
    assert.ok(shown.includes(refs.live), "the live entry is listed");
    assert.ok(!shown.includes(refs.gone), "the expired entry is hidden by default");

    const all = runCli(["list", "--root", root, "--include-expired", "--json"]);
    const allIds = JSON.parse(all.stdout).map((e) => e.id);
    assert.ok(allIds.includes(refs.gone), "--include-expired reveals the expired entry");
  });

  test("list's human view omits meta; --json includes it", async () => {
    const root = await seed(async (s) => {
      await s.push("with meta", { meta: { hint: "opaque" } });
    });
    const human = runCli(["list", "--root", root]);
    assert.ok(!human.stdout.includes("opaque"), "the human table does not disclose meta");
    const json = runCli(["list", "--root", root, "--json"]);
    assert.ok(json.stdout.includes("opaque"), "--json carries meta for scripting");
  });

  test("tombstones lists a grave after a drop; a clean store has none", async () => {
    const dropped = {};
    const root = await seed(async (s) => {
      await s.push("survivor");
      dropped.ref = await s.push("condemned");
      await s.drop(dropped.ref);
    });
    const { stdout, status } = runCli(["tombstones", "--root", root, "--json"]);
    assert.equal(status, 0);
    const graves = JSON.parse(stdout);
    assert.equal(graves.length, 1);
    assert.equal(graves[0].id, dropped.ref);
    assert.equal(graves[0].cause, "drop");
  });

  test("prune destroys expired entries and leaves live ones", async () => {
    const root = await seed(async (s) => {
      await s.push("keeps living");
      await s.push("short lived", { ttl: 1 });
      await new Promise((r) => setTimeout(r, 10));
    });
    const { stdout, status } = runCli(["prune", "--root", root, "--json"]);
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout).pruned, 1);
    const after = runCli(["stats", "--root", root, "--json"]);
    assert.equal(JSON.parse(after.stdout).entries, 1, "the live entry survives");
  });

  test("verify on a clean store reports no findings, exit 0", async () => {
    const root = await seed(async (s) => {
      await s.push("healthy");
    });
    const { stdout, status } = runCli(["verify", "--root", root, "--json"]);
    assert.equal(status, 0);
    const report = JSON.parse(stdout);
    assert.deepEqual(report.findings, []);
  });

  test("verify reports a corrupt blob and exits with the damage code; --repair removes it, healthy entries survive", async () => {
    const damaged = {};
    const root = await seed(async (s) => {
      damaged.ref = await s.push("about to rot");
      damaged.healthy = await s.push("stays intact");
    });
    // Bit-flip the stored blob so it no longer matches its recorded digest.
    const blobPath = join(root, "blobs", damaged.ref);
    const buf = readFileSync(blobPath);
    buf[0] ^= 0xff;
    writeFileSync(blobPath, buf);

    const dry = runCli(["verify", "--root", root, "--json"]);
    assert.equal(dry.status, 1, "damage exits with the fsck damage code");
    const report = JSON.parse(dry.stdout);
    assert.ok(report.findings.some((f) => f.kind === "digest-mismatch" && f.id === damaged.ref));
    assert.equal(readdirSync(join(root, "blobs")).length, 2, "a dry-run removes nothing");

    const repair = runCli(["verify", "--repair", "--root", root, "--json"]);
    assert.equal(repair.status, 0, "after repair the store is clean");
    const healthy = runCli(["has", damaged.healthy, "--root", root, "--json"]);
    assert.equal(JSON.parse(healthy.stdout).present, true, "the healthy entry is spared");
    const rotted = runCli(["has", damaged.ref, "--root", root, "--json"]);
    assert.equal(JSON.parse(rotted.stdout).present, false, "the condemned entry is gone");
  });

  test("has prints true/false and exits 0; a malformed ref is EBADREF exit 3 with no ref echoed", async () => {
    const present = {};
    const root = await seed(async (s) => {
      present.ref = await s.push("present");
    });
    const yes = runCli(["has", present.ref, "--root", root]);
    assert.equal(yes.status, 0);
    assert.equal(yes.stdout.trim(), "true");

    const absent = runCli(["has", "v1_" + "A".repeat(43), "--root", root]);
    assert.equal(absent.status, 0);
    assert.equal(absent.stdout.trim(), "false");

    const hostile = "../../etc/passwd";
    const bad = runCli(["has", hostile, "--root", root]);
    assert.equal(bad.status, 3, "a malformed ref exits with the bad-ref code");
    assert.ok(bad.stderr.includes("EBADREF"), "the frozen code is printed");
    assert.ok(!bad.stderr.includes(hostile), "the hostile ref is NOT echoed (capability-free error)");
  });

  test("a missing root is refused, not conjured, and no path is echoed", async () => {
    const bogus = join(freshScratchDir("cli-missing"), "no-such-store");
    const { stderr, status } = runCli(["stats", "--root", bogus]);
    assert.equal(status, 2, "a missing root is a usage error");
    assert.ok(!stderr.includes(bogus), "the root path is NOT echoed in the error");
    // And it did not create the store.
    const again = runCli(["stats", "--root", bogus]);
    assert.equal(again.status, 2, "the CLI did not conjure an empty store on the first run");
  });

  test("an unknown command and an unknown flag are usage errors (exit 2), no input echoed", async () => {
    const cmd = runCli(["frobnicate"]);
    assert.equal(cmd.status, 2);
    assert.ok(!cmd.stderr.includes("frobnicate"), "the unknown command is not echoed");

    const root = await seed(async (s) => { await s.push("x"); });
    const flag = runCli(["stats", "--root", root, "--nonsense"]);
    assert.equal(flag.status, 2);
    assert.ok(!flag.stderr.includes("nonsense"), "the unknown flag is not echoed");
  });

  test("no arguments prints help and exits 0", () => {
    const { stdout, status } = runCli([]);
    assert.equal(status, 0);
    assert.ok(stdout.includes("Usage: stashjs"), "help synopsis printed");
  });

  test("--help documents every subcommand (no drift between COMMANDS and the help text)", () => {
    const { stdout } = runCli(["--help"]);
    for (const name of COMMAND_NAMES) {
      assert.ok(new RegExp("\\b" + name + "\\b").test(stdout), `--help documents '${name}'`);
    }
  });

  test("--version prints the package version", () => {
    const { stdout, status } = runCli(["--version"]);
    assert.equal(status, 0);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  test("the CLI holds the permission posture: a granted root inspects, no wider grant needed", async () => {
    const root = await seed(async (s) => { await s.push("inside the grant"); });
    // Spawn the CLI itself under --permission, granting read on the install dir (to
    // load the module graph) plus read/write on the stash root -- the same grant the
    // library requires. A stats against the granted root must succeed.
    const appRoot = dirname(dirname(CLI)); // repo root (module graph)
    const r = spawnSync(process.execPath, [
      "--permission",
      "--allow-fs-read=" + appRoot,
      "--allow-fs-read=" + root,
      "--allow-fs-write=" + root,
      CLI, "stats", "--root", root, "--json",
    ], { encoding: "utf8" });
    assert.equal(r.status, 0, "stats under --permission on the granted root succeeds: " + (r.stderr || ""));
    assert.equal(JSON.parse(r.stdout).entries, 1);
  });
});
