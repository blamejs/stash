#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
/**
 * @module     stash.cli
 * @nav        Tools
 * @title      CLI
 * @order      60
 * @slug       cli
 *
 * @intro
 *   The operational CLI: inspect and maintain a disk-backed stash from the shell
 *   without writing a Node program. It ships as the `stashjs` command
 *   (`npx @blamejs/stash <subcommand>`), and it composes ONLY the shipped query
 *   and maintenance verbs -- `verify`, `stats`, `prune`, `list`, `tombstones`,
 *   `has`. It never moves bytes: `push` / `apply` / `pop` / `store` mint or stream
 *   capabilities and blobs, and `drop` / `clear` destroy by ref, so they belong to
 *   the embedding application, not a maintenance tool. The CLI hands out no
 *   capability and streams no blob.
 *
 *   The root comes from `--root <dir>`, else `STASH_ROOT`, else `./.stash`. It must
 *   already exist as a disk backend layout: the CLI refuses a missing root rather
 *   than conjuring an empty store from a typo. Add `--json` to any subcommand for a
 *   machine-readable document instead of the human table.
 *
 *   Single-writer-per-root is the store's operating constraint (SPEC.md 6): every
 *   subcommand except `verify` runs the crash-recovery scan first, which can
 *   reclaim a stale claim -- so point the CLI at a stash whose owning process is
 *   stopped, or at a cold-standby replica, never at a root a live app is serving.
 *
 *   Errors fail closed with stable exit codes and never echo a ref, a meta value,
 *   or a filesystem path. Run under `node --permission` with read/write scoped to
 *   the root (plus read on the install dir) exactly as the library requires.
 *
 * @card
 *   Inspect and maintain a disk stash from the shell -- verify, stats, prune,
 *   list, tombstones, has -- without writing Node. Never moves bytes.
 */

import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DiskBackend, CORE_SUBDIRS } from "./backends/disk.js";
import { StashError } from "./errors.js";
import { Stash, version } from "./index.js";
import { isValid } from "./ref.js";

// Stable, documented exit codes (fail-closed): distinct for each verdict class so a
// cron/fsck caller can branch. Frozen alongside the error catalog (SPEC.md 10).
export const EXIT = Object.freeze({
  OK: 0, // success, or a clean verify
  DAMAGE: 1, // verify found findings (the fsck convention -- alert on non-zero)
  USAGE: 2, // bad invocation: unknown subcommand/flag, missing argument
  BAD_REF: 3, // a malformed ref was refused (EBADREF) before any backend access
  INTEGRITY: 4, // stored bytes disagreed with their manifest (EINTEGRITY)
  FAULT: 5, // an I/O or access fault, or any other typed error
});

// exitForError(err) -> a stable exit code for a thrown error. Keys on the frozen
// StashError code (SPEC.md 10), never the message, so the mapping cannot drift with
// wording. A non-StashError (an fs fault, an access denial) is FAULT.
function exitForError(err) {
  if (err instanceof StashError) {
    if (err.code === "EBADREF") return EXIT.BAD_REF;
    if (err.code === "EINTEGRITY") return EXIT.INTEGRITY;
  }
  return EXIT.FAULT;
}

// A usage fault (exit 2). Static messages only -- never interpolate operator input
// (a ref mistyped as a subcommand must not echo back as a pseudo-capability).
class UsageError extends Error {}

const HELP = `stashjs -- inspect and maintain a disk-backed @blamejs/stash from the shell.

Usage: stashjs <command> [--root <dir>] [--json] [command flags]

Commands:
  verify [--repair]        Audit the store for damage; --repair removes condemned
                           blob/sidecar pairs, orphans, and corrupt graves.
  stats                    Print entry count, stored bytes, and claimed count.
  prune                    Destroy already-expired entries and reap old graves.
  list [--include-expired] List entries (metadata only, never contents).
  tombstones               List the graves left by destroyed entries.
  has <ref>                Print whether a ref is present (true/false).

Root resolution: --root <dir>, else $STASH_ROOT, else ./.stash. The root must
already exist as a disk backend layout; a missing root is refused, not created.

Add --json to any command for a machine-readable document. --version prints the
version. Point this only at a quiesced stash or a cold-standby replica: every
command except verify runs the crash-recovery scan and can reclaim a stale claim.`;

// resolveRoot(flags, env) -> the disk root (SPEC.md 4 default ./.stash).
function resolveRoot(flags, env) {
  if (flags.root !== undefined) return flags.root;
  if (env.STASH_ROOT) return env.STASH_ROOT;
  return "./.stash";
}

// assertStashLayout(root) -- refuse a missing/non-stash root rather than letting
// DiskBackend #init conjure an empty store from a typo (which would report "0
// entries" and mask the mistake). No path is echoed (capability-in-error-message) --
// the operator sees their own --root argument.
function assertStashLayout(root) {
  // A real disk root carries the CORE layout: require every directory that has DEFINED a
  // stash (CORE_SUBDIRS, imported so this can never drift from the backend), so a partial
  // or wrong directory is refused, not silently completed into an empty store -- #init
  // would otherwise re-create any missing one on first use. The auto-created delivered/
  // dir (SPEC.md 6 burn markers, added in 0.1.17) is deliberately NOT required, so a stash written
  // by an older version -- which has no delivered/ -- is still recognized and served, and
  // the backend creates the dir on first use. A missing core directory (ENOENT/ENOTDIR) is
  // "no stash here" -- a usage error the operator fixes by correcting --root -- but an
  // access or I/O fault (EACCES, ...) is a REAL fault surfaced distinctly, never masked.
  for (const sub of CORE_SUBDIRS) {
    let st;
    try {
      st = statSync(join(root, sub));
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") {
        throw new UsageError("stash root not found (expected an existing disk backend layout)");
      }
      throw err; // EACCES / EIO / ... -- a real access fault, not a usage error
    }
    if (!st.isDirectory()) {
      throw new UsageError("stash root is not a disk backend layout");
    }
  }
}

// The per-subcommand flag specs handed to parseArgs (strict: unknown flags fault).
const COMMON = { root: { type: "string" }, json: { type: "boolean", default: false } };
const COMMANDS = {
  verify: { options: { ...COMMON, repair: { type: "boolean", default: false } }, positionals: 0, run: cmdVerify },
  stats: { options: { ...COMMON }, positionals: 0, run: cmdStats },
  prune: { options: { ...COMMON }, positionals: 0, run: cmdPrune },
  list: { options: { ...COMMON, "include-expired": { type: "boolean", default: false } }, positionals: 0, run: cmdList },
  tombstones: { options: { ...COMMON }, positionals: 0, run: cmdTombstones },
  has: { options: { ...COMMON }, positionals: 1, refPositional: true, run: cmdHas },
};

// The subcommand names, exported so a test pins that --help documents every one --
// a new command added to COMMANDS but not to HELP is a drift the suite catches (the
// drift-free-help discipline without a separate snapshot).
export const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));

// A fresh one-shot Stash over the root: no sweep timer (construct, run one verb,
// exit), the safe restore-on-pop-failure default (an inspection tool must never
// silently BURN an abandoned claim), and the standard identity guards.
function openStash(root) {
  assertStashLayout(root);
  return new Stash({ backend: new DiskBackend({ root }), sweepInterval: null });
}

function render(io, json, human, machine) {
  io.out.write((json ? JSON.stringify(machine) : human) + "\n");
}

function pad(value, width) {
  const s = String(value);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function whenText(ms) {
  return ms === null ? "never" : new Date(ms).toISOString();
}

async function cmdVerify(stash, flags, _pos, io) {
  const report = await stash.verify({ repair: flags.repair });
  if (flags.json) {
    io.out.write(JSON.stringify(report) + "\n");
  } else {
    const lines = [`scanned ${report.scanned}, findings ${report.findings.length}, repaired ${report.repaired.length}`];
    for (const f of report.findings) lines.push(`  ${pad(f.kind, 18)} ${f.id === null ? "(unnamed)" : f.id}`);
    io.out.write(lines.join("\n") + "\n");
  }
  // DAMAGE only if damage REMAINS: a dry run (repaired empty) leaves every finding
  // unresolved; --repair clears the findings it condemned, so what remains is the
  // damage repair could not or would not fix (a spared stale-claim, a claimed entry).
  // A --repair run that resolved everything it found is a clean exit.
  const unresolved = report.findings.filter(
    (f) => !report.repaired.some((r) => r.kind === f.kind && r.id === f.id),
  );
  return unresolved.length > 0 ? EXIT.DAMAGE : EXIT.OK;
}

async function cmdStats(stash, flags, _pos, io) {
  const stats = await stash.stats();
  render(io, flags.json, `entries ${stats.entries}, bytes ${stats.bytes}, claimed ${stats.claimed}`, stats);
  return EXIT.OK;
}

async function cmdPrune(stash, flags, _pos, io) {
  const pruned = await stash.prune();
  render(io, flags.json, `pruned ${pruned}`, { pruned });
  return EXIT.OK;
}

async function cmdList(stash, flags, _pos, io) {
  const entries = await stash.list({ includeExpired: flags["include-expired"] });
  if (flags.json) {
    io.out.write(JSON.stringify(entries) + "\n");
  } else {
    // The human view omits `meta` (caller-supplied opaque hints -- a needless
    // disclosure in a casual table); --json carries it for scripting.
    const lines = [`${pad("ref", 47)} ${pad("size", 10)} ${pad("created", 26)} ${pad("expires", 26)} reads`];
    for (const e of entries) {
      lines.push(`${pad(e.id, 47)} ${pad(e.size, 10)} ${pad(whenText(e.createdAt), 26)} ${pad(whenText(e.expiresAt), 26)} ${e.readsLeft === null ? "-" : e.readsLeft}`);
    }
    io.out.write(lines.join("\n") + "\n");
  }
  return EXIT.OK;
}

async function cmdTombstones(stash, flags, _pos, io) {
  const graves = await stash.tombstones();
  if (flags.json) {
    io.out.write(JSON.stringify(graves) + "\n");
  } else {
    const lines = [`${pad("ref", 47)} ${pad("destroyed", 26)} cause`];
    for (const g of graves) lines.push(`${pad(g.id, 47)} ${pad(whenText(g.destroyedAt), 26)} ${g.cause}`);
    io.out.write(lines.join("\n") + "\n");
  }
  return EXIT.OK;
}

async function cmdHas(stash, flags, pos, io) {
  // stash.has validates the ref at the whitelist BEFORE any backend access, so a
  // malformed ref throws InvalidRef (EBADREF) -> caught below -> BAD_REF. Present and
  // absent both exit OK; the boolean is the answer, a non-zero exit is a real error.
  const present = await stash.has(pos[0]);
  render(io, flags.json, present ? "true" : "false", { present });
  return EXIT.OK;
}

// main(argv, io) -> exit code. `io` = { out, err, env } so the whole surface is
// testable by spawning the entry AND callable in-process. Never calls process.exit
// itself; the entry guard below does, from the returned code.
export async function main(argv, io) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    io.out.write(HELP + "\n");
    return EXIT.OK;
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    io.out.write(version + "\n");
    return EXIT.OK;
  }
  // COMMANDS is indexed by an UNTRUSTED argv token, so membership is Object.hasOwn,
  // never a bare `COMMANDS[name]` read: a token naming an inherited Object.prototype
  // member ("constructor", "__proto__", "toString") would resolve to that member and
  // slip past the `spec === undefined` guard as a phantom command (CWE-1321,
  // prototype-key confusion) -- the same discipline digest.js applies to a stored
  // digest's algorithm prefix.
  const name = argv[0];
  const spec = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (spec === undefined) {
    io.err.write("stashjs: unknown command (run stashjs --help)\n");
    return EXIT.USAGE;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv.slice(1), options: spec.options, allowPositionals: true, strict: true });
  } catch {
    // parseArgs throws on an unknown/malformed flag; its message can quote operator
    // input, so it is swallowed and a static usage line is printed instead.
    io.err.write("stashjs: invalid options (run stashjs --help)\n");
    return EXIT.USAGE;
  }
  if (parsed.positionals.length !== spec.positionals) {
    io.err.write("stashjs: wrong number of arguments (run stashjs --help)\n");
    return EXIT.USAGE;
  }
  // A ref argument is validated at the whitelist BEFORE the root is opened -- ref
  // validation precedes any storage access (hard rule 4), so a malformed ref is
  // refused with zero filesystem I/O, regardless of the root's state.
  if (spec.refPositional && !isValid(parsed.positionals[0])) {
    io.err.write("stashjs: EBADREF\n");
    return EXIT.BAD_REF;
  }
  let stash;
  try {
    stash = openStash(resolveRoot(parsed.values, io.env));
    return await spec.run(stash, parsed.values, parsed.positionals, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err.write("stashjs: " + err.message + "\n");
      return EXIT.USAGE;
    }
    // Fail loud, capability-free: the frozen code, never the ref/meta/path.
    io.err.write("stashjs: " + (err instanceof StashError ? err.code : "a filesystem or access fault") + "\n");
    return exitForError(err);
  } finally {
    if (stash) await stash.close();
  }
}

// Entry guard: run only when invoked as the process entry (the bin), never on
// import (the suite spawns the entry, it does not import it). Compare real paths so
// a relative argv, a symlinked bin shim, and Windows separators all resolve alike.
function invokedAsEntry() {
  if (process.argv[1] === undefined) return false;
  let entry = null;
  let self = null;
  try {
    entry = realpathSync(process.argv[1]);
    self = realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that cannot be resolved is not this entry -- fall through to the
    // inequality below rather than returning from the catch (both stay null).
    entry = null;
  }
  return entry !== null && entry === self;
}

if (invokedAsEntry()) {
  main(process.argv.slice(2), { out: process.stdout, err: process.stderr, env: process.env })
    .then((code) => process.exit(code))
    .catch(() => process.exit(EXIT.FAULT));
}
