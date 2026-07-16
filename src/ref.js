// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// @internal -- no operator-facing namespace. Refs are minted and validated
// here and only here; the documented surface is the Stash methods that
// accept and return them.
//
// ref -- generate, validate, and compare stash refs.
//
// A ref is a capability, not an address: 'v1_' + 32 random bytes as
// base64url (43 chars, no padding), 256 bits of entropy, unguessable. It is
// never derived from content (a content hash is an enumeration oracle --
// anyone holding the plaintext could probe for the ref).
//
// Refs become filenames in the disk backend, so validation here is the
// path-traversal defense: a ref that is not character-for-character
// well-formed dies at the regex, before any storage access. Whitelist, no
// normalization, no path.resolve rescue.

import { randomBytes, timingSafeEqual } from "node:crypto";

import { C } from "./constants.js";
import { InvalidRef } from "./errors.js";

// The one shape a ref may have. 32 random bytes -> 43 base64url chars,
// unpadded, behind the version prefix. The regex is written literally --
// the whitelist IS the guard, and deriving it would hide it -- and pinned
// to C.REF by test.
const REF_PATTERN = /^v1_[A-Za-z0-9_-]{43}$/;

// generate() -> string. Mint a fresh ref.
export function generate() {
  return C.REF.PREFIX + randomBytes(C.REF.RANDOM_BYTES).toString("base64url");
}

// isValid(ref) -> boolean. Character-for-character whitelist match. The
// pattern is declared here and only here: a second declaration would be a
// second traversal surface to keep correct.
// @enforced-by guard-shape-reinlined
// @guard-shape v1_\[A-Za-z0-9_-\]
export function isValid(ref) {
  return typeof ref === "string" && REF_PATTERN.test(ref);
}

// assertValid(ref) -> ref | throws InvalidRef. Every public method routes
// its ref argument through here BEFORE any backend call.
// @enforced-by behavioral -- the reject-before-storage rule has no
//   rename-proof code shape of its own (the pattern shape is isValid's);
//   the zero-backend-calls conformance vector is the guard.
export function assertValid(ref) {
  if (!isValid(ref)) throw new InvalidRef();
  return ref;
}

// constantTimeEqual(a, b) -> boolean. Timing-safe string equality for
// capability and digest comparison. Length is not secret; content is.
// @enforced-by guard-shape-reinlined
// @guard-shape \btimingSafeEqual\s*\(
export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
