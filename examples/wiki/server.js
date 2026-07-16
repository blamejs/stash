// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
// stashjs.com documentation site - production entry.
//
// The site is generated entirely from the @module + @primitive comment
// blocks in the library's src/ (see lib/page-generator). This file is the
// zero-dependency HTTP shim: it builds the page map once at boot and
// serves it, plus the static assets, the content-hashed CSS/JS, the
// /search route, the /symbols.json autocomplete manifest, and the
// sitemap/robots crawl surface. Rebuild-at-boot keeps the pages a pure
// function of the source - no database, no seeders, no runtime deps.
//
// Env vars:
//   WIKI_PORT       HTTP port (default 3011)
//   WIKI_BIND       bind address (default 0.0.0.0)
//   WIKI_SITE_URL   canonical public URL (default https://stashjs.com)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as generator from "./lib/page-generator.js";

var PORT = parseInt(process.env.WIKI_PORT, 10) || 3011;
var BIND = process.env.WIKI_BIND || "0.0.0.0";

var PUBLIC_DIR = path.join(import.meta.dirname, "public");

// Static assets served from public/ by exact request path. The logo doubles
// as the favicon and PWA icon (see the shell head + manifest.webmanifest),
// so no derived icon files ship. CSS/JS are NOT here - those serve
// content-hashed from the in-memory map lib/assets builds at boot.
var STATIC_ASSETS = {
  "/stashjs-logo.png":     { file: "stashjs-logo.png",     type: "image/png" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json" },
};

// Response security headers on EVERY response. Styles and scripts are
// external content-hashed files, so the CSP carries no 'unsafe-inline'
// anywhere; the only inline <script> is each page's JSON-LD block, admitted
// by its sha256 hash (per page, passed to _csp below). Every image the site
// renders is served locally, so img-src stays 'self' (plus data: for
// completeness).
function _csp(scriptHashes) {
  var script = "'self'" + (scriptHashes && scriptHashes.length ? " " + scriptHashes.join(" ") : "");
  return "default-src 'self'; " +
    "img-src 'self' data:; " +
    "style-src 'self'; " +
    "script-src " + script + "; " +
    "font-src 'self'; " +
    "connect-src 'self'; " +
    "manifest-src 'self'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'; " +
    "object-src 'none'; " +
    "upgrade-insecure-requests";
}

var SECURITY_HEADERS = {
  "content-security-policy": _csp(null),
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
};

function _withSecurity(headers) {
  var h = {};
  Object.keys(SECURITY_HEADERS).forEach(function (k) { h[k] = SECURITY_HEADERS[k]; });
  Object.keys(headers || {}).forEach(function (k) { h[k] = headers[k]; });
  return h;
}

// Strong-ETag conditional GET: a matching If-None-Match answers 304 with
// no body. Pages are prebuilt so the etag is computed once at boot.
function _etagMatches(req, etag) {
  var inm = req.headers["if-none-match"];
  if (!inm || !etag) return false;
  return inm.split(",").some(function (t) {
    return t.trim().replace(/^W\//, "") === etag;
  });
}

// buildSite() is exported so test/e2e.js boots the identical page map
// in-process without opening a socket.
export function buildSite() {
  return generator.build({});
}

export function createServer(site) {
  return http.createServer(function (req, res) {
    var q = req.url.indexOf("?") !== -1 ? req.url.slice(req.url.indexOf("?") + 1) : "";
    var url = req.url.split("?")[0];

    // Normalize a trailing slash (except root) BEFORE any route matching,
    // so "/search/" and "/stash/" behave exactly like their canonical forms.
    if (url.length > 1 && url.charAt(url.length - 1) === "/") url = url.slice(0, -1);

    // Liveness/readiness probe for a container healthcheck. Pages are
    // generated at boot, so a served /healthz means the site is up.
    if (url === "/healthz") {
      res.writeHead(200, _withSecurity({ "content-type": "application/json" }));
      res.end(JSON.stringify({ status: "ok", pages: Object.keys(site.pages).length }));
      return;
    }

    // Content-hashed CSS/JS from memory: the hash in the URL makes the
    // body immutable for that URL, so the cache lifetime is maximal.
    var hashed = site.assets && site.assets.files[url];
    if (hashed) {
      res.writeHead(200, _withSecurity({
        "content-type": hashed.type,
        "cache-control": "public, max-age=31536000, immutable",
      }));
      res.end(hashed.body);
      return;
    }

    var asset = STATIC_ASSETS[url];
    if (asset) {
      fs.readFile(path.join(PUBLIC_DIR, asset.file), function (err, buf) {
        if (err) { res.writeHead(404, _withSecurity({ "content-type": "text/plain" })); res.end("not found"); return; }
        res.writeHead(200, _withSecurity({ "content-type": asset.type, "cache-control": "public, max-age=86400" }));
        res.end(buf);
      });
      return;
    }

    // The symbol-search autocomplete manifest (see lib/symbol-index).
    if (url === "/symbols.json") {
      res.writeHead(200, _withSecurity({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=300",
      }));
      res.end(site.symbolsJson);
      return;
    }

    if (url === "/sitemap.xml") {
      res.writeHead(200, _withSecurity({ "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" }));
      res.end(site.sitemapXml);
      return;
    }

    if (url === "/robots.txt") {
      res.writeHead(200, _withSecurity({ "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" }));
      res.end(site.robotsTxt);
      return;
    }

    // Server-rendered full-text search: a plain GET form target, so search
    // works with JavaScript disabled.
    if (url === "/search") {
      var query;
      try { query = new URLSearchParams(q).get("q") || ""; } catch (_e) { query = ""; }
      res.writeHead(200, _withSecurity({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      }));
      res.end(generator.renderSearch(site, query));
      return;
    }

    var page = site.pages[url];
    if (!page) {
      res.writeHead(404, _withSecurity({ "content-type": "text/html; charset=utf-8" }));
      res.end("<!doctype html><meta charset=utf-8><title>404 - StashJS</title><h1>404</h1><p>No such page. <a href=\"/\">Home</a></p>");
      return;
    }
    var pageHeaders = {
      "content-security-policy": _csp(page.cspScriptHashes),
      "cache-control": "public, max-age=300",
      "etag": page.etag,
    };
    if (_etagMatches(req, page.etag)) {
      res.writeHead(304, _withSecurity(pageHeaders));
      res.end();
      return;
    }
    pageHeaders["content-type"] = "text/html; charset=utf-8";
    res.writeHead(200, _withSecurity(pageHeaders));
    res.end(page.html);
  });
}

export function start() {
  var site = buildSite();
  var server = createServer(site);
  server.listen(PORT, BIND, function () {
    var host = BIND === "0.0.0.0" ? "localhost" : BIND;
    var pageCount = Object.keys(site.pages).length;
    console.log("stashjs.com docs listening on http://" + host + ":" + PORT + " (" + pageCount + " pages)");
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
