// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
// symbol-index - the /symbols.json autocomplete manifest.
//
// Built at generation time from the same primitive index that resolves
// @related cross-references, so the sidebar symbol search and the page
// anchors can never disagree. Each entry:
//
//   { sig, bare, page, anchor, title }
//
//   sig    display signature ("stash.push(source, opts) -> Promise<string>",
//          falling back to the @primitive tag when no @signature exists)
//   bare   match key without arguments ("stash.push")
//   page   the page path ("/stash")
//   anchor the section anchor on that page ("stash-push")
//   title  the owning page title (shown under the signature)

export function build(entries, docsByNs, helpers) {
  var symbols = [];
  entries.forEach(function (e) {
    var rec = docsByNs[e.namespaces[0]];
    if (!rec) return;
    rec.primitives.forEach(function (p) {
      var tags = p.tags || {};
      if (!tags.primitive) return;
      var bare = helpers.bare(tags.primitive);
      symbols.push({
        sig:    tags.signature ? String(tags.signature).replace(/\s+/g, " ").trim() : tags.primitive,
        bare:   bare,
        page:   "/" + e.slug,
        anchor: helpers.anchor(bare),
        title:  e.title,
      });
    });
  });
  symbols.sort(function (a, b) { return a.bare < b.bare ? -1 : a.bare > b.bare ? 1 : 0; });
  return symbols;
}
