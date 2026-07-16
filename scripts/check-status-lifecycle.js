// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Gate: the experimental-status lifecycle ledger.
//
// Every @primitive whose @status is `experimental` must carry a decision in
// lifecycle-reviews.json -- keep-experimental with a reason and a reviewBy
// horizon -- and the ledger must stay honest: an entry whose primitive
// graduated or vanished is stale, and a horizon the current version has
// reached means the review is DUE (graduate, extend with a recorded
// reason, or remove). Experimental never accretes silently.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

function extractStatuses() {
  const out = new Map();
  for (const file of walk(join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const block of text.match(/\/\*\*[\s\S]*?\*\//g) || []) {
      const primitive = /@primitive\s+(\S+)/.exec(block);
      if (primitive === null) continue;
      const status = /@status\s+(\S+)/.exec(block);
      out.set(primitive[1], status === null ? null : status[1]);
    }
  }
  return out;
}

// versionAtLeast(a, b) -> a >= b, numeric semver triples.
function versionAtLeast(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return true;
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const ledger = JSON.parse(readFileSync(join(ROOT, "lifecycle-reviews.json"), "utf8"));
const statuses = extractStatuses();

const problems = [];
for (const [token, status] of statuses) {
  if (status === "experimental" && !(token in ledger)) {
    problems.push(token + ": @status experimental with no lifecycle-reviews.json entry");
  }
}
for (const [token, entry] of Object.entries(ledger)) {
  if (!statuses.has(token)) {
    problems.push(token + ": ledger entry for a primitive that no longer exists");
    continue;
  }
  if (statuses.get(token) !== "experimental") {
    problems.push(token + ": graduated to '" + statuses.get(token) + "' but still carries a ledger entry -- remove it");
  }
  if (entry.decision !== "keep-experimental") {
    problems.push(token + ": unknown decision '" + entry.decision + "'");
  }
  if (typeof entry.reason !== "string" || entry.reason.length < 20) {
    problems.push(token + ": a keep-experimental decision needs a substantive reason");
  }
  if (typeof entry.reviewBy !== "string" || !/^\d+\.\d+\.\d+$/.test(entry.reviewBy)) {
    problems.push(token + ": reviewBy must be a version horizon");
  } else if (versionAtLeast(pkg.version, entry.reviewBy)) {
    problems.push(token + ": review DUE (reviewBy " + entry.reviewBy + " <= current " + pkg.version + ") -- graduate, extend with a reason, or remove");
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error("status-lifecycle: " + p);
  process.exit(1);
}
console.log("status-lifecycle: " + Object.keys(ledger).length + " experimental primitive(s) reviewed, none due before " + pkg.version);
