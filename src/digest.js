// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// @internal -- no operator-facing namespace. The integrity-hash registry: the
// ONE place the digest algorithm set, its output lengths, the stored-digest
// shape, and the hash factory are defined. Operators pick an algorithm through
// the `digest` constructor option; everything else composes this module.
//
// digest -- the store's integrity hash. StashJS is crypto-agnostic for
// INTEGRITY, not confidentiality (SPEC.md 1 is untouched: still no key, no
// cipher). The digest verifies bytes read out are the bytes written in; it is
// never a lookup key (SPEC.md 5).
//
// The stored digest is SELF-DESCRIBING -- `"<algo>:<hex>"` -- so a read verifies
// with the algorithm the entry was WRITTEN with, never a global assumption. A
// store may therefore hold entries under different algorithms (the option
// changed over its life, or a `store()` replicated an entry with its own
// algorithm) and each still verifies. The construct-time option sets the
// algorithm for NEW writes only.
//
// node:crypto builtins only (zero-dependency). sha2 is FIPS 180-4; sha3 and
// shake are FIPS 202. shake256 is an extensible-output function (XOF) whose
// length is not fixed by the algorithm, so it is PINNED here to 64 bytes
// (512-bit) -- an unpinned XOF would make the stored hex length ambiguous.

import { createHash } from "node:crypto";

import { oneOf } from "./validate.js";

// algo -> { hash: node:crypto name, bytes: output length, opts?: createHash opts }.
// A new algorithm is one frozen row; the pattern, validator, and factory all
// derive from this table, so nothing else names an algorithm or a hex length.
export const DIGESTS = Object.freeze({
  sha256: Object.freeze({ hash: "sha256", bytes: 32 }),
  sha512: Object.freeze({ hash: "sha512", bytes: 64 }),
  "sha3-256": Object.freeze({ hash: "sha3-256", bytes: 32 }),
  "sha3-512": Object.freeze({ hash: "sha3-512", bytes: 64 }),
  shake256: Object.freeze({ hash: "shake256", bytes: 64, opts: Object.freeze({ outputLength: 64 }) }),
});

// The default keeps every existing store byte-identical: sha256, the algorithm
// M1-M8 shipped, so an omitted `digest` option changes nothing.
export const DEFAULT_DIGEST = "sha256";

// digestHash(algo) -> a fresh node:crypto Hash for the algorithm. Caller has
// already validated `algo` (assertDigestAlgo at config time, or a stored digest's
// own prefix on the read path), so the row is always present.
export function digestHash(algo) {
  const d = DIGESTS[algo];
  return createHash(d.hash, d.opts);
}

// finalize(hash, algo) -> the stored `"<algo>:<hex>"` string. The one place the
// stored form is assembled, so the write side and the read side never disagree
// on the shape.
export function finalize(hash, algo) {
  return algo + ":" + hash.digest("hex");
}

// digestMarker(algo) -> the SELF-DESCRIBING pending digest `"<algo>:"` (the chosen
// algorithm, hex not yet computed). The policy layer stamps a fresh push's entry
// with this so the algorithm travels INSIDE the documented `write(id, source, entry)`
// contract -- a custom backend reads it back with algoOf() and computes that hash,
// rather than depending on an out-of-band argument it may not honor. Same colon
// shape as finalize(), so algoOf() parses both a marker and a full stored digest.
export function digestMarker(algo) {
  return algo + ":";
}

// isValidDigest(value) -> boolean. A stored digest is `"<algo>:<hex>"` with a
// registry algorithm and a hex length that matches its byte count exactly. This
// is the read-side shape gate (entry.js composes it for the Entry schema) --
// rename/extension-proof: a new DIGESTS row extends it with no edit here.
//
// The prefix is UNTRUSTED bytes (a replicated entry, a disk sidecar), so
// membership is Object.hasOwn, never a bare `DIGESTS[prefix]` read: a prefix
// like "constructor" or "__proto__" resolves to an INHERITED Object.prototype
// member, and treating that non-undefined value as a registry hit would read an
// algorithm the store does not define (CWE-1321, prototype-key confusion).
export function isValidDigest(value) {
  if (typeof value !== "string") return false;
  const colon = value.indexOf(":");
  if (colon === -1) return false;
  const algo = value.slice(0, colon);
  if (!Object.hasOwn(DIGESTS, algo)) return false;
  const hex = value.slice(colon + 1);
  return hex.length === DIGESTS[algo].bytes * 2 && /^[0-9a-f]*$/.test(hex);
}

// algoOf(stored) -> the algorithm named by a stored digest's prefix, or null if
// the prefix is not a registry algorithm. Drives the SELF-DESCRIBING read: the
// verify/audit paths hash with the entry's OWN algorithm, never a global one, and
// the write path reads the requested algorithm off the entry's digest. Resolves a
// hex-less `"<algo>:"` (the digestMarker a fresh push carries) as well as a full
// `"<algo>:<hex>"` -- only the prefix before the colon is consulted.
//
// Membership is Object.hasOwn, never a bare `DIGESTS[prefix] === undefined`: the
// prefix is untrusted, and an inherited Object.prototype key ("constructor",
// "__proto__", "toString") resolves to a non-undefined member. Returning that
// phantom name instead of null would report an algorithm the registry never
// defined -- and silently defeat the write path's `algoOf(digest) ?? DEFAULT`
// fallback, sending a name digestHash cannot construct (CWE-1321).
export function algoOf(stored) {
  if (typeof stored !== "string") return null;
  const colon = stored.indexOf(":");
  if (colon === -1) return null;
  const algo = stored.slice(0, colon);
  return Object.hasOwn(DIGESTS, algo) ? algo : null;
}

// assertDigestAlgo(value, label) -> algo | throws TypeError. Config-time
// validation of the `digest` constructor option: a value outside the registry is
// a boot-time typo, not a runtime verdict (three-tier validation, tier 1). The
// closed-enum "expected one of" shape is owned by validate.oneOf (a re-inline is
// a gate failure), so this composes it over the registry's algorithm names.
export function assertDigestAlgo(value, label = "digest") {
  return oneOf(value, label, Object.keys(DIGESTS));
}
