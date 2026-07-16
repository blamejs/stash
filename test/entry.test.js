// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
import { test } from "node:test";
import assert from "node:assert/strict";

import { isExpired, make } from "../src/entry.js";

// The focused contract of the one expiry comparator (the choke point every
// read verb, list's filter, and prune route through). The `<=` boundary is
// what makes a ttl:0 push deterministically expired at birth.
test("isExpired: a null expiresAt is never expired", () => {
  assert.equal(isExpired({ expiresAt: null }, Date.now()), false);
  assert.equal(isExpired({ expiresAt: null }, 0), false);
});

test("isExpired: the deadline is inclusive -- now === expiresAt is expired", () => {
  assert.equal(isExpired({ expiresAt: 1000 }, 999), false); // before the deadline
  assert.equal(isExpired({ expiresAt: 1000 }, 1000), true); // AT the deadline
  assert.equal(isExpired({ expiresAt: 1000 }, 1001), true); // past the deadline
});

test("make stamps expiresAt from its own createdAt; a null ttl leaves it null", () => {
  const none = make("v1_none", {}, null);
  assert.equal(none.expiresAt, null);
  assert.equal(none.createdAt !== null && Number.isSafeInteger(none.createdAt), true);
  const ttl = make("v1_ttl", {}, 5000);
  assert.equal(ttl.expiresAt, ttl.createdAt + 5000);
});

test("make omits the ttl argument as no expiry (M1 callers stay valid)", () => {
  assert.equal(make("v1_default", {}).expiresAt, null);
});

test("make refuses a ttl whose expiresAt sum leaves the safe-integer range", () => {
  // createdAt + MAX_SAFE_INTEGER overflows the exact range: a config typo must
  // not manufacture a serialized-as-null "never expires" or an integrity lie.
  assert.throws(() => make("v1_over", {}, Number.MAX_SAFE_INTEGER), TypeError);
});
