// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Regenerate api-snapshot.json from the live public surface. The snapshot
// freezes the API shape (members, kinds, arities) and each primitive's
// @since version; check-api-snapshot.js diffs the live surface against it
// on every gate run so a breaking change cannot land silently.
//
// Refuses to overwrite history: an existing snapshot's @since values are
// immutable, so a shipped primitive cannot be re-dated.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = join(ROOT, "api-snapshot.json");
const MAX_DEPTH = 8;

function isClassFunction(value) {
  return /^class[\s{]/.test(Function.prototype.toString.call(value));
}

// describeValue(value, depth) -> a structural descriptor. Classes carry
// their prototype methods so a removed or re-aritied method is a diff.
export function describeValue(value, depth) {
  if (depth > MAX_DEPTH) return { kind: "max-depth" };
  if (typeof value === "function") {
    if (isClassFunction(value)) {
      const methods = {};
      const proto = value.prototype || {};
      for (const name of Object.getOwnPropertyNames(proto).sort()) {
        if (name === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        if (typeof desc.value === "function") {
          methods[name] = { kind: "function", arity: desc.value.length };
        }
      }
      return { kind: "class", arity: value.length, methods };
    }
    return { kind: "function", arity: value.length };
  }
  if (Array.isArray(value)) return { kind: "array", length: value.length };
  if (value !== null && typeof value === "object") {
    const members = {};
    for (const key of Object.keys(value).sort()) {
      members[key] = describeValue(value[key], depth + 1);
    }
    return { kind: "object", members };
  }
  return { kind: typeof value };
}

// capture() -> { surface, sinceByPrimitive }. The surface walks every
// public entry point: the root index and each exported backend subpath.
export async function capture() {
  const index = await import(new URL("../src/index.js", import.meta.url));
  const memory = await import(new URL("../src/backends/memory.js", import.meta.url));
  const disk = await import(new URL("../src/backends/disk.js", import.meta.url));
  const conformance = await import(new URL("../src/conformance.js", import.meta.url));
  const surface = {
    index: describeValue({ ...index }, 0),
    "backends/memory": describeValue({ ...memory }, 0),
    "backends/disk": describeValue({ ...disk }, 0),
    conformance: describeValue({ ...conformance }, 0),
  };
  return { surface, sinceByPrimitive: extractSince() };
}

function walkSourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkSourceFiles(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

// extractSince() -> { "stash.push": "0.1.0", ... } from the @primitive
// comment blocks in src/.
export function extractSince() {
  const out = {};
  for (const file of walkSourceFiles(join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const block of text.match(/\/\*\*[\s\S]*?\*\//g) || []) {
      const primitive = /@primitive\s+(\S+)/.exec(block);
      if (primitive === null) continue;
      const since = /@since\s+(\S+)/.exec(block);
      out[primitive[1]] = since === null ? null : since[1];
    }
  }
  return out;
}

// assertSinceImmutable(previous, next) -> throws when a shipped
// primitive's @since changed or vanished without the primitive vanishing.
export function assertSinceImmutable(previous, next) {
  const problems = [];
  for (const [token, version] of Object.entries(previous.sinceByPrimitive || {})) {
    if (!(token in next.sinceByPrimitive)) continue; // primitive removed: the surface diff owns that verdict
    if (next.sinceByPrimitive[token] !== version) {
      problems.push(token + ": @since changed from " + version + " to " + next.sinceByPrimitive[token]);
    }
  }
  for (const [token, version] of Object.entries(next.sinceByPrimitive)) {
    if (version === null) problems.push(token + ": @primitive block is missing @since");
  }
  if (problems.length > 0) {
    throw new Error("since-immutability violations:\n  " + problems.join("\n  "));
  }
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const next = await capture();
  if (existsSync(SNAPSHOT_PATH)) {
    const previous = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    assertSinceImmutable(previous, next);
  }
  const snapshot = {
    generator: "scripts/refresh-api-snapshot.js",
    packageVersion: pkg.version,
    surface: next.surface,
    sinceByPrimitive: next.sinceByPrimitive,
  };
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");
  console.log("api-snapshot.json refreshed: " +
    Object.keys(next.sinceByPrimitive).length + " primitives, package " + pkg.version);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(2);
  });
}
