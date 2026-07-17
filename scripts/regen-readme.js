// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Regenerate the README's error-code table from src/errors.js -- the single
// source of truth for the typed error surface (SPEC.md 10). The table lives
// between the BEGIN/END markers below; everything else in the README is
// hand-written. A frozen code table that drifted from errors.js would document
// a branch surface the store no longer speaks, so this runs in the gates:
//
//   node scripts/regen-readme.js           # rewrite the table in place
//   node scripts/regen-readme.js --check   # fail if the checked-in table drifted
//
// Kept deliberately small and dependency-free, the changelog-regen precedent.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");
const ERRORS = join(ROOT, "src", "errors.js");

const BEGIN = "<!-- BEGIN error-codes (generated from src/errors.js by scripts/regen-readme.js) -->";
const END = "<!-- END error-codes -->";

// Each error class carries a one-line JSDoc ending in `Code: <CODE>.` right
// above its `export class <Name> extends StashError`. Harvest all three so the
// table is exactly the shipped set, in declaration order.
function harvestErrors() {
  const src = readFileSync(ERRORS, "utf8");
  const re = /\/\*\* ([^\n]*?) Code: (\w+)\. \*\/\s*export class (\w+) extends StashError/g;
  const rows = [];
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    rows.push({ description: m[1].trim(), code: m[2], name: m[3] });
  }
  if (rows.length === 0) throw new Error("regen-readme: no error classes harvested from src/errors.js");
  // Completeness cross-check: the harvest regex needs a single-line `Code: X.` JSDoc
  // right above each class. A class added with a multi-line doc would be silently
  // dropped, and --check (regen vs regen) would still pass on an incomplete table --
  // a dead gate. Count the actual subclasses and demand every one was harvested.
  const declared = (src.match(/export class \w+ extends StashError/g) || []).length;
  if (rows.length !== declared) {
    throw new Error(
      "regen-readme: harvested " + rows.length + " error rows but src/errors.js declares " + declared +
      " StashError subclass(es) -- a class is missing its single-line `Code: <CODE>.` JSDoc",
    );
  }
  return rows;
}

function renderTable(rows) {
  const lines = [
    BEGIN,
    "",
    "| Code | Class | Raised when |",
    "|---|---|---|",
    ...rows.map((r) => `| \`${r.code}\` | \`${r.name}\` | ${r.description} |`),
    "",
    END,
  ];
  return lines.join("\n");
}

function splice(readme, table) {
  const start = readme.indexOf(BEGIN);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error("regen-readme: BEGIN/END error-code markers not found in README.md");
  }
  return readme.slice(0, start) + table + readme.slice(end + END.length);
}

const readme = readFileSync(README, "utf8");
const next = splice(readme, renderTable(harvestErrors()));
const check = process.argv.includes("--check");

if (check) {
  if (next !== readme) {
    console.error("[regen-readme] README.md error-code table is stale -- run `node scripts/regen-readme.js` and commit");
    process.exit(1);
  }
  console.log("[regen-readme] ok -- README.md error-code table matches src/errors.js");
} else {
  if (next !== readme) writeFileSync(README, next);
  console.log("[regen-readme] wrote README.md error-code table (" + harvestErrors().length + " codes)");
}
