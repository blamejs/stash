// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
// site.config - the single source of truth for the wiki's navigation and
// landing-page curation. Everything is DERIVED: the entries come straight
// from the @module blocks in the library's src/ (see lib/auto-site-entries).
// There are no hand-authored seeders - adding or moving a page is a
// comment-block edit alone.
//
// Exposes:
//   LIB_DIR             absolute path to the library's src/
//   siteUrl             canonical public URL of the deploy
//   entries()           the auto-derived site entries (sorted)
//   navGroups()         [ { group, items: [ { slug, title, path } ] } ]
//   groupForPath(path)  the nav group a page path belongs to, or null

import path from "node:path";
import * as auto from "./lib/auto-site-entries.js";

export const LIB_DIR = path.resolve(import.meta.dirname, "..", "..", "src");
export const siteUrl = (process.env.WIKI_SITE_URL || "https://stashjs.com").replace(/\/+$/, "");

export function entries() {
  return auto.deriveFromLib(LIB_DIR);
}

export function navGroups() {
  var order = [];
  var map = {};
  entries().forEach(function (e) {
    if (!map[e.group]) { map[e.group] = []; order.push(e.group); }
    map[e.group].push({ slug: e.slug, title: e.title, path: "/" + e.slug });
  });
  return order.map(function (g) { return { group: g, items: map[g] }; });
}

export function groupForPath(p) {
  var found = null;
  entries().forEach(function (e) {
    if ("/" + e.slug === p) found = e.group;
  });
  return found;
}
