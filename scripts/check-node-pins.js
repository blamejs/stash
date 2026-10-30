// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// check-node-pins: every Node runtime pinned in the tree satisfies
// package.json `engines.node`.
//
// `engines.node` names the Node releases the package supports, one range per
// release line (`>=24.22.1 <25 || >=26.12.1`). The tree also pins Node in
// places npm never reads: `.node-version`, `.nvmrc`, the workflow
// `node-version` inputs, the test compose image, and the wiki container's
// base image. Raising the floor in package.json leaves each of those where it
// was. This gate reads every one of them and fails on a pin outside the range.
//
// The wiki base image is pinned by digest, so its Node version is not in the
// text. `--image` runs the pinned image with `--version` (requires docker) and
// checks the result; CI runs that form. Without `--image` the gate is offline
// and runs with the other static gates.
//
// The range grammar accepted is the subset `engines` uses here: `||`-separated
// sets of space-separated `>=`, `>`, `<=`, `<` or `=` comparators on X.Y.Z
// versions, with X or X.Y also accepted after `<` and `>=`. Anything else
// throws, so a range the gate cannot read fails instead of passing.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;
const COMPARATOR = /^(>=|<=|>|<|=)?(\d+(?:\.\d+(?:\.\d+)?)?)$/;

function parseVersion(text) {
  const m = VERSION.exec(String(text).trim());
  if (!m) throw new TypeError(`not an X.Y.Z version: ${text}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function parseRange(range) {
  if (typeof range !== "string" || range.trim() === "") {
    throw new TypeError("engines.node is missing or empty");
  }
  return range.split("||").map((set) => {
    const parts = set.trim().split(/\s+/);
    if (parts.length === 0 || parts[0] === "") throw new TypeError(`empty set in range: ${range}`);
    return parts.map((part) => {
      const m = COMPARATOR.exec(part);
      if (!m) throw new TypeError(`unsupported comparator "${part}" in range: ${range}`);
      const op = m[1] || "=";
      const fields = m[2].split(".");
      // `<25` means `<25.0.0` and `>=26.12` means `>=26.12.0`. For any other
      // operator a partial version does not mean the zero-padded one (`>25`
      // is `>=26.0.0`), so only full versions are accepted there.
      if (fields.length < 3 && op !== "<" && op !== ">=") {
        throw new TypeError(`partial version needs < or >=: "${part}" in range: ${range}`);
      }
      while (fields.length < 3) fields.push("0");
      return { op, version: parseVersion(fields.join(".")) };
    });
  });
}

export function satisfies(version, range) {
  const v = parseVersion(version);
  return parseRange(range).some((set) =>
    set.every(({ op, version: bound }) => {
      const c = compare(v, bound);
      if (op === ">=") return c >= 0;
      if (op === ">") return c > 0;
      if (op === "<=") return c <= 0;
      if (op === "<") return c < 0;
      return c === 0;
    }),
  );
}

// Each source names a file and how to pull Node versions out of it. A source
// that yields no version is a finding: the pin moved or the pattern drifted,
// and either way the gate would otherwise pass without checking anything.
export const SOURCES = [
  { file: ".node-version", pattern: /^v?(\d+\.\d+\.\d+)\s*$/gm },
  { file: ".nvmrc", pattern: /^v?(\d+\.\d+\.\d+)\s*$/gm },
  { file: ".github/workflows/ci.yml", pattern: /^\s*node:\s*\[\s*"(\d+\.\d+\.\d+)"/gm },
  { file: ".github/workflows/fuzz.yml", pattern: /node-version:\s*["']?(\d+\.\d+\.\d+)/g },
  { file: ".github/workflows/npm-publish.yml", pattern: /node-version:\s*["']?(\d+\.\d+\.\d+)/g },
  { file: ".github/workflows/release-container.yml", pattern: /\bnode:(\d+\.\d+\.\d+)-alpine/g },
  { file: "docker-compose.test.yml", pattern: /image:\s*node:(\d+\.\d+\.\d+)-alpine/g },
];

export function findPins(text, pattern) {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map((m) => m[1]);
}

const WIKI_BASE = /^ARG BASE_RUNTIME=(\S+@sha256:[0-9a-f]{64})\s*$/m;

export function wikiBaseImage(dockerfile) {
  const m = WIKI_BASE.exec(dockerfile);
  if (!m) throw new TypeError("examples/wiki/Dockerfile has no digest-pinned ARG BASE_RUNTIME");
  return m[1];
}

export function checkPins({ engines, wikiEngines, sources }) {
  const problems = [];
  parseRange(engines);
  if (wikiEngines !== engines) {
    problems.push(
      `examples/wiki/package.json engines.node (${wikiEngines}) does not match package.json (${engines})`,
    );
  }
  for (const { file, versions } of sources) {
    if (versions.length === 0) {
      problems.push(`${file}: no Node version pin found`);
      continue;
    }
    for (const v of versions) {
      if (!satisfies(v, engines)) {
        problems.push(`${file}: Node ${v} does not satisfy engines.node ${engines}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = (name) => readFileSync(join(ROOT, name), "utf8");
  const engines = (JSON.parse(read("package.json")).engines || {}).node;
  const wikiEngines = (JSON.parse(read("examples/wiki/package.json")).engines || {}).node;
  const sources = SOURCES.map(({ file, pattern }) => ({
    file,
    versions: findPins(read(file), pattern),
  }));

  if (process.argv.includes("--image")) {
    const image = wikiBaseImage(read("examples/wiki/Dockerfile"));
    const version = execFileSync("docker", ["run", "--rm", image, "--version"], {
      encoding: "utf8",
    }).trim();
    console.log(`[node-pins] ${image} runs Node ${version}`);
    sources.push({ file: "examples/wiki/Dockerfile BASE_RUNTIME", versions: [version] });
  }

  const problems = checkPins({ engines, wikiEngines, sources });
  if (problems.length > 0) {
    for (const p of problems) console.error(`[node-pins] ${p}`);
    process.exit(1);
  }
  const count = sources.reduce((n, s) => n + s.versions.length, 0);
  console.log(`[node-pins] ok: ${count} pin(s) satisfy engines.node ${engines}`);
}
