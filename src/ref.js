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

import { InvalidRef } from "./errors.js";

// The one shape a ref may have. 32 bytes -> 43 base64url chars, unpadded.
const REF_PATTERN = /^v1_[A-Za-z0-9_-]{43}$/;

// generate() -> string. Mint a fresh ref.
export function generate() {
  return "v1_" + randomBytes(32).toString("base64url");
}

// isValid(ref) -> boolean. Character-for-character whitelist match.
export function isValid(ref) {
  return typeof ref === "string" && REF_PATTERN.test(ref);
}

// assertValid(ref) -> ref | throws InvalidRef. Every public method routes
// its ref argument through here BEFORE any backend call.
export function assertValid(ref) {
  if (!isValid(ref)) throw new InvalidRef();
  return ref;
}

// constantTimeEqual(a, b) -> boolean. Timing-safe string equality for
// capability and digest comparison. Length is not secret; content is.
export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
