// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Regenerate CHANGELOG.md from the structured release notes at
// release-notes/v<X>.<Y>.<Z>.json, newest version first. The JSON files
// are the single source: each carries the version, the release date, a
// one-paragraph summary, and the section bullets; this script renders the
// exact CHANGELOG bytes (LF line endings, em-dash headings, 77-column
// greedy word wrap) so the changelog can never drift from its source.
//
// Usage:
//   node scripts/regen-changelog.js            # rewrite CHANGELOG.md
//   node scripts/regen-changelog.js --check    # regenerate to memory,
//                                              # diff against disk,
//                                              # exit 1 on drift
//
// Exit codes:
//   0  changelog written / matches disk
//   1  --check drift, malformed release notes, or an unrecognized entry
//      in release-notes/ (only v<X>.<Y>.<Z>.json files may live there --
//      a misnamed note would otherwise vanish from the CHANGELOG with
//      the check still green)

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOTES_DIR = join(ROOT, "release-notes");
const CHANGELOG_PATH = join(ROOT, "CHANGELOG.md");

const EM_DASH = "\u2014";
const WIDTH = 77;
const PREAMBLE =
  "# Changelog\n" +
  "\n" +
  "All notable changes to `@blamejs/stash` are documented here, newest first.\n";

// Keep a Changelog's canonical section order; unknown headings sort after,
// in first-seen order.
const SECTION_ORDER = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security", "Migration"];

// Malformed input throws; the CLI entry point turns the throw into a
// prefixed stderr line + exit 1, and importing consumers (tests) assert
// on the throw directly.
function fail(msg) {
  throw new Error(msg);
}

const NOTE_NAME_RE = /^v\d+\.\d+\.\d+\.json$/;

function readNote(dir, name) {
  const filePath = join(dir, name);
  let payload;
  try {
    payload = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    fail("release-notes/" + name + ": " + (e && e.message ? e.message : e));
  }
  const version = name.replace(/^v/, "").replace(/\.json$/, "");
  if (payload.version !== version) {
    fail("release-notes/" + name + ": version field " +
      JSON.stringify(payload.version) + " does not match the filename");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.date || ""))) {
    fail("release-notes/" + name + ": date must be YYYY-MM-DD");
  }
  if (typeof payload.summary !== "string" || payload.summary.length === 0) {
    fail("release-notes/" + name + ": summary is required");
  }
  const sections = payload.sections;
  if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
    fail("release-notes/" + name + ": sections must be an object keyed by heading");
  }
  for (const heading of Object.keys(sections)) {
    if (!Array.isArray(sections[heading]) || sections[heading].length === 0) {
      fail("release-notes/" + name + ": section " + JSON.stringify(heading) +
        " must be a non-empty array of bullet strings");
    }
  }
  return payload;
}

function compareVersionsDesc(a, b) {
  const ap = a.split(".").map(Number);
  const bp = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (ap[i] !== bp[i]) return bp[i] - ap[i];
  }
  return 0;
}

// loadNotes(dir) -> parsed notes, newest version first. Every directory
// entry MUST be a v<X>.<Y>.<Z>.json note: an entry the version filter
// does not recognize is an error, never a skip -- a skipped note's
// changes silently vanish from the CHANGELOG while --check stays green.
export function loadNotes(dir = NOTES_DIR) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    fail("cannot read release-notes/: " + (e && e.message ? e.message : e));
  }
  const strays = entries.filter((name) => !NOTE_NAME_RE.test(name));
  if (strays.length > 0) {
    fail("release-notes/ contains unrecognized entries (only v<X>.<Y>.<Z>.json " +
      "release notes may live here): " + strays.join(", "));
  }
  const notes = entries.map((name) => readNote(dir, name));
  if (notes.length === 0) fail("no release-notes/v<X>.<Y>.<Z>.json files found");
  notes.sort((a, b) => compareVersionsDesc(a.version, b.version));
  return notes;
}

// Greedy word wrap: fill each line up to WIDTH columns. The first line
// carries firstPrefix ("- " for a bullet, "" for a paragraph); continuation
// lines carry contPrefix ("  " for a bullet). A single word longer than the
// budget lands on its own line rather than being split.
function wrap(text, firstPrefix, contPrefix) {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines = [];
  let line = firstPrefix;
  let bare = true;
  for (const word of words) {
    const candidate = bare ? line + word : line + " " + word;
    if (!bare && candidate.length > WIDTH) {
      lines.push(line);
      line = contPrefix + word;
    } else {
      line = candidate;
    }
    bare = false;
  }
  lines.push(line);
  return lines;
}

function orderedHeadings(sections) {
  const known = SECTION_ORDER.filter((h) => Object.prototype.hasOwnProperty.call(sections, h));
  const unknown = Object.keys(sections).filter((h) => SECTION_ORDER.indexOf(h) === -1);
  return known.concat(unknown);
}

function renderEntry(note) {
  const lines = [];
  lines.push("## " + note.version + " " + EM_DASH + " " + note.date);
  lines.push("");
  for (const l of wrap(note.summary, "", "")) lines.push(l);
  for (const heading of orderedHeadings(note.sections)) {
    lines.push("");
    lines.push("### " + heading);
    lines.push("");
    for (const bullet of note.sections[heading]) {
      for (const l of wrap(bullet, "- ", "  ")) lines.push(l);
    }
  }
  return lines.join("\n") + "\n";
}

// render(notes) -> the exact CHANGELOG.md bytes for the given notes.
export function render(notes) {
  return PREAMBLE + "\n" + notes.map(renderEntry).join("\n");
}

function main() {
  const check = process.argv.indexOf("--check") !== -1;
  const generated = render(loadNotes());

  if (check) {
    let onDisk = null;
    try {
      onDisk = readFileSync(CHANGELOG_PATH, "utf8");
    } catch (e) {
      fail("cannot read CHANGELOG.md: " + (e && e.message ? e.message : e));
    }
    if (onDisk === generated) {
      process.stdout.write("[regen-changelog] ok -- CHANGELOG.md matches release-notes/\n");
      return;
    }
    const diskLines = onDisk.split("\n");
    const genLines = generated.split("\n");
    const max = Math.max(diskLines.length, genLines.length);
    for (let i = 0; i < max; i += 1) {
      if (diskLines[i] !== genLines[i]) {
        process.stderr.write("[regen-changelog] CHECK FAIL -- CHANGELOG.md drifts from release-notes/ at line " + (i + 1) + ":\n");
        process.stderr.write("  disk:      " + JSON.stringify(diskLines[i] === undefined ? "(missing)" : diskLines[i]) + "\n");
        process.stderr.write("  generated: " + JSON.stringify(genLines[i] === undefined ? "(missing)" : genLines[i]) + "\n");
        break;
      }
    }
    process.stderr.write("[regen-changelog] run `node scripts/regen-changelog.js` to rewrite, or fix the release notes\n");
    process.exit(1);
  }

  writeFileSync(CHANGELOG_PATH, generated);
  process.stdout.write("[regen-changelog] wrote CHANGELOG.md from " +
    "release-notes/ (" + generated.length + " bytes)\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    process.stderr.write("[regen-changelog] " + (e && e.message ? e.message : e) + "\n");
    process.exit(1);
  }
}
