// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DIGESTS,
  DEFAULT_DIGEST,
  algoOf,
  digestHash,
  digestMarker,
  finalize,
  isValidDigest,
  assertDigestAlgo,
} from "../src/digest.js";

const ALGOS = Object.keys(DIGESTS);

// Prefixes that resolve to an INHERITED Object.prototype member via a bare
// `DIGESTS[key]` bracket read -- the ones a `x === undefined` membership test
// mistakes for a registry hit. `__proto__` reaches the prototype accessor;
// `constructor` the Object constructor; the rest are Object.prototype methods.
const PROTO_KEYS = [
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
];

test("algoOf names the algorithm of a well-formed stored digest and resolves a hex-less marker", () => {
  for (const algo of ALGOS) {
    const stored = finalize(digestHash(algo).update(Buffer.from("payload")), algo);
    assert.equal(algoOf(stored), algo, "a full stored digest names its algorithm");
    assert.equal(algoOf(digestMarker(algo)), algo, "a hex-less marker resolves the same algorithm");
  }
});

test("algoOf returns null for a non-registry prefix -- including inherited Object.prototype keys", () => {
  // A stored digest's algorithm prefix is untrusted bytes (a replicated entry, a
  // disk sidecar). algoOf must report a MISS as null for any prefix that is not a
  // registry algorithm -- a bare `DIGESTS[prefix] === undefined` membership test
  // instead returns the inherited member for a prefix like "constructor" or
  // "__proto__", so the self-describing read resolves a phantom algorithm that
  // exists nowhere in the registry.
  assert.equal(algoOf("md5:" + "0".repeat(32)), null, "an unknown-but-plain prefix is a miss");
  for (const key of PROTO_KEYS) {
    assert.equal(algoOf(key + ":" + "0".repeat(64)), null, `prefix '${key}' is not a registry algorithm`);
    assert.equal(algoOf(key + ":"), null, `marker-shaped '${key}:' is not a registry algorithm either`);
  }
  assert.equal(algoOf("no-colon"), null);
  assert.equal(algoOf(42), null);
  assert.equal(algoOf(null), null);
});

test("the write-path fallback `algoOf(digest) ?? DEFAULT_DIGEST` always yields a usable algorithm", () => {
  // The disk and memory backends compute `const algo = algoOf(entry.digest) ??
  // DEFAULT_DIGEST` and hand the result straight to digestHash(algo). A prefix
  // that is not a registry algorithm must resolve through the `?? DEFAULT_DIGEST`
  // fallback to sha256 -- if algoOf returns a phantom prototype-key name instead
  // of null, the fallback is silently defeated and digestHash throws on the
  // phantom name, crashing the write with a raw TypeError instead of hashing.
  for (const key of PROTO_KEYS) {
    const algo = algoOf(key + ":" + "0".repeat(64)) ?? DEFAULT_DIGEST;
    assert.equal(algo, DEFAULT_DIGEST, `'${key}:' must fall through to the default algorithm`);
    assert.doesNotThrow(() => digestHash(algo), "the fallback algorithm constructs a hash");
  }
});

test("isValidDigest accepts a well-formed <algo>:<hex> and fails closed on everything else", () => {
  for (const algo of ALGOS) {
    const stored = finalize(digestHash(algo).update(Buffer.from("payload")), algo);
    assert.equal(isValidDigest(stored), true, `${algo} full digest is valid`);
    // wrong hex length for the algorithm
    assert.equal(isValidDigest(algo + ":" + "0".repeat(2)), false, `${algo} with short hex is rejected`);
    // a hex-less marker is not a stored digest
    assert.equal(isValidDigest(digestMarker(algo)), false, `${algo} marker (hex-less) is not a stored digest`);
    // uppercase hex is not the lowercase form finalize emits
    const upper = stored.slice(0, stored.indexOf(":") + 1) + stored.slice(stored.indexOf(":") + 1).toUpperCase();
    assert.equal(isValidDigest(upper), false, `${algo} uppercase hex is rejected`);
  }
  // non-registry and inherited-key prefixes fail closed
  assert.equal(isValidDigest("md5:" + "0".repeat(32)), false);
  for (const key of PROTO_KEYS) {
    assert.equal(isValidDigest(key + ":" + "0".repeat(64)), false, `prefix '${key}' fails closed`);
  }
  assert.equal(isValidDigest("no-colon"), false);
  assert.equal(isValidDigest(42), false);
  assert.equal(isValidDigest(""), false);
});

test("assertDigestAlgo is a closed enum over the registry -- an inherited key is not an algorithm", () => {
  for (const algo of ALGOS) assert.equal(assertDigestAlgo(algo), algo);
  assert.throws(() => assertDigestAlgo("md5"), TypeError);
  for (const key of PROTO_KEYS) {
    assert.throws(() => assertDigestAlgo(key), TypeError, `'${key}' is not a selectable algorithm`);
  }
});

test("finalize round-trips through algoOf and isValidDigest for every algorithm", () => {
  for (const algo of ALGOS) {
    const stored = finalize(digestHash(algo).update(Buffer.from("abc")), algo);
    assert.ok(stored.startsWith(algo + ":"));
    assert.equal(algoOf(stored), algo);
    assert.equal(isValidDigest(stored), true);
    // the stored hex length matches the algorithm's byte count exactly
    assert.equal(stored.slice(algo.length + 1).length, DIGESTS[algo].bytes * 2);
  }
});
