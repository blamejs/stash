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

// Known-answer vectors for "abc", from FIPS 180-4 (SHA-2) and FIPS 202
// (SHA-3, SHAKE). Every other digest test round-trips -- push hashes, a read
// re-hashes with the entry's own algorithm, and the two are compared -- so if
// a runtime ever changed an algorithm's output BOTH halves would move together
// and the suite would stay green, while every entry already stored would fail
// verification with IntegrityError. These pin the runtime to the standards
// instead of to itself, which is what makes a Node or OpenSSL upgrade a test
// failure rather than an unreadable store.
//
// shake256 is an XOF, so its length is the registry's pinned 64 bytes.
const KNOWN_ANSWERS = Object.freeze({
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  sha512:
    "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
  "sha3-256": "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532",
  "sha3-512":
    "b751850b1a57168a5693cd924b6b096e08f621827444f70d884f5d0240d2712e10e116e9192af3c91a7ec57647e3934057340b4cf408d5a56592f8274eec53f0",
  shake256:
    "483366601360a8771c6863080cc4114d8db44530f8f1e1ee4f94ea37e78b5739d5a15bef186a5386c75744c0527e1faa9f8726e462a12a4feb06bd8801e751e4",
});

test("every registry algorithm reproduces its published digest for 'abc'", () => {
  for (const algo of ALGOS) {
    const expected = KNOWN_ANSWERS[algo];
    assert.ok(expected, `${algo} is in the registry but has no known-answer vector`);
    const stored = finalize(digestHash(algo).update(Buffer.from("abc")), algo);
    assert.equal(
      stored,
      `${algo}:${expected}`,
      `${algo} does not match its published value -- the runtime's digest changed`,
    );
  }
});

test("the known-answer table covers the registry exactly", () => {
  // A new registry row without a vector would otherwise be silently unpinned.
  assert.deepEqual(Object.keys(KNOWN_ANSWERS).sort(), [...ALGOS].sort());
});

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
    assert.equal(
      algoOf(key + ":" + "0".repeat(64)),
      null,
      `prefix '${key}' is not a registry algorithm`,
    );
    assert.equal(
      algoOf(key + ":"),
      null,
      `marker-shaped '${key}:' is not a registry algorithm either`,
    );
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
    assert.equal(
      isValidDigest(algo + ":" + "0".repeat(2)),
      false,
      `${algo} with short hex is rejected`,
    );
    // a hex-less marker is not a stored digest
    assert.equal(
      isValidDigest(digestMarker(algo)),
      false,
      `${algo} marker (hex-less) is not a stored digest`,
    );
    // uppercase hex is not the lowercase form finalize emits
    const upper =
      stored.slice(0, stored.indexOf(":") + 1) +
      stored.slice(stored.indexOf(":") + 1).toUpperCase();
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
