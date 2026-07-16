// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// Fuzz target: ref validation on arbitrary byte strings.
//
// A ref becomes a filename in the disk backend, so the src/ref.js
// whitelist is the store's path-traversal defense (SPEC.md 5). This
// target holds three properties on every input:
//
//   1. isValid never throws and always returns a boolean, and a freshly
//      minted ref always passes its own whitelist;
//   2. the guard and the consumer path agree: a string the whitelist
//      rejects dies at InvalidRef (EBADREF) before any backend call, and
//      a string it accepts reaches the backend (RefNotFound on an empty
//      store);
//   3. constantTimeEqual never throws, is reflexive, and refuses a
//      same-prefix extension.
//
// A typed StashError is the correct verdict for hostile input. Anything
// else escaping -- a TypeError, a RangeError, one of the property
// assertions below -- is a real finding.

import { MemoryBackend } from "../src/backends/memory.js";
import { StashError } from "../src/errors.js";
import { constantTimeEqual, generate, isValid } from "../src/ref.js";
import { Stash } from "../src/stash.js";

const stash = new Stash({ backend: new MemoryBackend() });

async function probe(candidate) {
  const accepted = isValid(candidate);
  if (typeof accepted !== "boolean") {
    throw new Error("isValid returned a non-boolean");
  }
  if (!isValid(generate())) {
    throw new Error("a freshly minted ref failed its own whitelist");
  }
  if (!constantTimeEqual(candidate, candidate)) {
    throw new Error("constantTimeEqual is not reflexive");
  }
  if (constantTimeEqual(candidate, candidate + "x")) {
    throw new Error("constantTimeEqual equated a string with its extension");
  }

  let code = null;
  try {
    await stash.show(candidate);
  } catch (err) {
    if (!(err instanceof StashError)) throw err;
    code = err.code;
  }
  const refused = code === "EBADREF";
  if (accepted && refused) {
    throw new Error("whitelist accepted a ref the consumer path refused as malformed");
  }
  if (!accepted && !refused) {
    throw new Error("whitelist rejected a ref that got past the consumer-path guard");
  }
  // A successful show cannot happen on an empty store, but it is a legal
  // outcome for the shape, not a finding.
  return code === null ? "found" : code;
}

// fuzz(data) -> the utf8 decoding's verdict ("EBADREF" | "ENOREF" |
// "found"). Both text decodings of the input are probed; jazzer.js awaits
// the returned promise, and local-smoke.js asserts on the verdict.
export async function fuzz(data) {
  const utf8 = data.toString("utf8");
  const latin1 = data.toString("latin1");
  const verdict = await probe(utf8);
  if (latin1 !== utf8) await probe(latin1);
  return verdict;
}
