// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
import { test } from "node:test";
import assert from "node:assert/strict";

import { generate, isValid, assertValid, constantTimeEqual } from "../src/ref.js";
import { C } from "../src/constants.js";
import { InvalidRef } from "../src/errors.js";

test("generate mints a whitelist-shaped, unique ref", () => {
  const seen = new Set();
  for (let i = 0; i < 64; i += 1) {
    const ref = generate();
    assert.match(ref, /^v1_[A-Za-z0-9_-]{43}$/);
    assert.equal(isValid(ref), true);
    assert.equal(seen.has(ref), false);
    seen.add(ref);
  }
});

test("traversal and malformed refs die at the whitelist", () => {
  const hostile = [
    "../../etc/passwd",
    "..\\..\\windows\\system32",
    "/etc/shadow",
    "C:\\Windows\\win.ini",
    "v1_..",
    "v1_../../../etc/passwd",
    "v1_" + "A".repeat(42), // one short
    "v1_" + "A".repeat(44), // one long
    "v1_" + "A".repeat(42) + "/", // slash inside
    "v1_" + "A".repeat(42) + ".", // dot inside
    "v2_" + "A".repeat(43), // unknown version
    "%76%31%5f" + "A".repeat(43), // URL-encoded prefix
    "v1_" + "A".repeat(40) + "%2e", // URL-encoded suffix
    "v1_" + "A".repeat(42) + "=", // padding char
    "",
    "v1_",
    42,
    null,
    undefined,
    {},
    Buffer.from("v1_" + "A".repeat(43)),
  ];
  for (const ref of hostile) {
    assert.equal(isValid(ref), false);
    assert.throws(() => assertValid(ref), (err) => {
      assert.ok(err instanceof InvalidRef);
      assert.equal(err.code, "EBADREF");
      // capability-hygiene: the message never echoes the input
      if (typeof ref === "string" && ref.length > 0) {
        assert.equal(err.message.includes(ref), false);
      }
      return true;
    });
  }
});

test("assertValid returns the ref it accepted", () => {
  const ref = generate();
  assert.equal(assertValid(ref), ref);
});

test("the whitelist regex and C.REF agree", () => {
  // The pattern is written literally (the whitelist IS the guard); this
  // pins it to the constants so neither can drift alone.
  const ref = generate();
  assert.equal(ref.length, C.REF.PREFIX.length + C.REF.ENCODED_LENGTH);
  assert.ok(ref.startsWith(C.REF.PREFIX));
  assert.equal(
    C.REF.ENCODED_LENGTH,
    Buffer.alloc(C.REF.RANDOM_BYTES).toString("base64url").length
  );
});

test("constantTimeEqual compares strings without type coercion", () => {
  const ref = generate();
  assert.equal(constantTimeEqual(ref, ref), true);
  assert.equal(constantTimeEqual(ref, generate()), false);
  assert.equal(constantTimeEqual(ref, ref + "x"), false);
  assert.equal(constantTimeEqual("", ""), true);
  assert.equal(constantTimeEqual(ref, 42), false);
  assert.equal(constantTimeEqual(null, null), false);
});
