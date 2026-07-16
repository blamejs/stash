// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
// harvest-errors - the /reference-errors catalog, generated from the
// library source at boot.
//
// The library's failure surface is a set of ESM error classes
// (src/errors.js), each a typed class with a stable string `code` field
// and a doc comment immediately above the declaration:
//
//   /** Unknown or expired ref. Code: ENOREF. */
//   export class RefNotFound extends StashError {
//     code = "ENOREF";
//     ...
//   }
//
// The harvest walks src/ (vendor/ and node_modules excluded) and collects
// every `export class X extends Y` whose doc block precedes it, reading:
//
//   name         the class name
//   base         the class it extends
//   code         the `code = "..."` class field, or null (the base class)
//   description  the doc block's text, comment markers stripped
//   file         the declaring file, src-relative
//
// Consumers branch on `.code`, never on message text, so the catalog is
// the stable contract surface: name + code + description per class.

import fs from "node:fs";
import path from "node:path";

// A doc block that may not contain a nested `*/`, immediately followed by
// an exported class declaration. Anchoring the block to the declaration
// keeps an earlier comment (the @module block) from being swallowed into
// a later class's description.
var CLASS_RE = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*export\s+class\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*)/g;
var CODE_FIELD_RE = /^\s*code\s*=\s*"([A-Za-z0-9_]+)"\s*;/m;

function _cleanDoc(raw) {
  return String(raw)
    .split("\n")
    .map(function (l) { return l.replace(/\r$/, "").replace(/^\s*\*\s?/, ""); })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function _eachSourceFile(libDir, fn) {
  function _walk(dir) {
    var names;
    try { names = fs.readdirSync(dir); } catch (_e) { return; }
    names.forEach(function (name) {
      if (name === "vendor" || name === "node_modules") return;
      var full = path.join(dir, name);
      var stat;
      try { stat = fs.statSync(full); } catch (_e) { return; }
      if (stat.isDirectory()) { _walk(full); return; }
      if (!stat.isFile() || !/\.js$/.test(name)) return;
      var src;
      try { src = fs.readFileSync(full, "utf8"); } catch (_e) { return; }
      fn(path.relative(libDir, full).replace(/\\/g, "/"), src);
    });
  }
  _walk(libDir);
}

// harvest(libDir) -> {
//   classes: [ { name, base, code, description, file } ],
//   classCount, codeCount,
// }
export function harvest(libDir) {
  var classes = [];
  var seenClass = {};

  _eachSourceFile(libDir, function (rel, src) {
    var m;
    CLASS_RE.lastIndex = 0;
    while ((m = CLASS_RE.exec(src)) !== null) {
      var name = m[2];
      if (seenClass[name]) continue;
      seenClass[name] = true;
      // Only the error family: the base class extends Error, every other
      // member extends a harvested class. A non-error class documented
      // with a doc block does not belong in this catalog.
      var base = m[3];
      // The class body runs from the match to the next exported class (or
      // EOF); the code field, when present, is declared at its top.
      var bodyEnd = src.indexOf("export class", CLASS_RE.lastIndex);
      var body = src.slice(CLASS_RE.lastIndex, bodyEnd === -1 ? src.length : bodyEnd);
      var codeMatch = CODE_FIELD_RE.exec(body);
      classes.push({
        name:        name,
        base:        base,
        code:        codeMatch ? codeMatch[1] : null,
        description: _cleanDoc(m[1]),
        file:        "src/" + rel,
        _isError:    base === "Error",
      });
    }
  });

  // Keep only classes in the error family: the root (extends Error) and
  // every class whose ancestry reaches it through harvested classes.
  var byName = {};
  classes.forEach(function (c) { byName[c.name] = c; });
  function _inFamily(c, hops) {
    if (hops > 16) return false;
    if (c._isError) return true;
    var parent = byName[c.base];
    return parent ? _inFamily(parent, hops + 1) : false;
  }
  var family = classes.filter(function (c) { return _inFamily(c, 0); });
  family.forEach(function (c) { delete c._isError; });

  // Base classes first, then alphabetical.
  family.sort(function (a, b) {
    var ab = a.base === "Error" ? 0 : 1;
    var bb = b.base === "Error" ? 0 : 1;
    if (ab !== bb) return ab - bb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  var codeCount = family.filter(function (c) { return c.code; }).length;
  return { classes: family, classCount: family.length, codeCount: codeCount };
}
