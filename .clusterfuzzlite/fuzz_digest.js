// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Fuzz target: the self-describing digest parser on arbitrary byte strings.
//
// A stored digest is "<algo>:<hex>" (SPEC.md 5). isValidDigest is the read-side
// shape gate the Entry schema composes, and algoOf resolves which algorithm a
// read/verify hashes with -- both parse UNTRUSTED stored bytes, and they must
// agree. This target drives the pure parsers directly (they are reached only
// indirectly through the sidecar today, via fuzz_sidecar's digest field) and
// holds three properties on every input:
//
//   1. isValidDigest never throws and always returns a boolean;
//   2. algoOf never throws and returns either a DIGESTS key or null;
//   3. they AGREE in the load-bearing direction: a digest isValidDigest accepts
//      MUST resolve to a known algorithm whose byte length matches the hex
//      length exactly -- otherwise a self-certifying digest could name an
//      algorithm the verify path cannot reproduce (fail-open, CWE-345). The
//      converse does not hold: algoOf may resolve a bare "<algo>:" marker or a
//      wrong-length hex that isValidDigest rejects -- that is the pending-marker
//      / bad-length case, not a finding.
//
// Any throw, a non-boolean, a non-registry algorithm, or an accepted digest
// whose algorithm/length disagree is a real finding.

import { DIGESTS, algoOf, isValidDigest } from "../src/digest.js";

// The parser is O(n) pure string work (indexOf / slice / a linear /^[0-9a-f]*$/),
// so it cannot hang; cap the input only so a pathological length can't OOM the
// local proof. 128 KiB is far above any real "<algo>:<hex>" (the longest is
// shake256/sha3-512/sha512 at ~137 bytes).
const MAX_INPUT = 128 * 1024;

// classify(s) -> "valid" | "algo-only" | "rejected", checking the properties as
// it goes. "valid": the shape gate accepts it. "algo-only": a known algorithm
// prefix the gate rejects (bare marker, wrong hex length, non-hex). "rejected":
// no registry algorithm prefix at all.
export function classify(s) {
  if (s.length > MAX_INPUT) s = s.slice(0, MAX_INPUT);
  const valid = isValidDigest(s);
  if (typeof valid !== "boolean") {
    throw new Error("isValidDigest returned a non-boolean");
  }
  const algo = algoOf(s);
  if (algo !== null && !Object.prototype.hasOwnProperty.call(DIGESTS, algo)) {
    throw new Error("algoOf returned a non-registry algorithm: " + JSON.stringify(algo));
  }
  if (valid) {
    if (algo === null) {
      throw new Error("isValidDigest accepted a digest algoOf could not resolve");
    }
    const hex = s.slice(s.indexOf(":") + 1);
    if (hex.length !== DIGESTS[algo].bytes * 2) {
      throw new Error("isValidDigest accepted a digest whose hex length disagrees with its algorithm");
    }
  }
  return valid ? "valid" : algo === null ? "rejected" : "algo-only";
}

// fuzz(data) -> the utf8 decoding's verdict. Both text decodings are probed so a
// byte string that changes meaning across encodings is exercised; the fuzzing
// engine and local-smoke.js assert on the returned verdict.
export async function fuzz(data) {
  const utf8 = data.toString("utf8");
  const latin1 = data.toString("latin1");
  const verdict = classify(utf8);
  if (latin1 !== utf8) classify(latin1);
  return verdict;
}
