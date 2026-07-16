// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../src/size.js";
import { C } from "../src/constants.js";

test("parses the documented size forms", () => {
  assert.equal(parse("64b"), 64);
  assert.equal(parse("512kb"), 512 * C.BYTES.KIB);
  assert.equal(parse("100mb"), 100 * C.BYTES.MIB);
  assert.equal(parse("1gb"), C.BYTES.GIB);
  assert.equal(parse("0b"), 0);
  assert.equal(parse(4096), 4096);
  assert.equal(parse(0), 0);
  assert.equal(parse(null), null);
  assert.equal(parse(undefined), null);
});

test("rejects malformed sizes at config time", () => {
  const bad = ["mb", "100", "1.5mb", "-1mb", "100 mb", "100kib", "10h", "1tb", "", "100mbb",
    NaN, Infinity, -1, 1.5, {}, [], true];
  for (const value of bad) {
    assert.throws(() => parse(value, "maxSize"), TypeError);
  }
});

test("the label names the offending option", () => {
  assert.throws(() => parse("nope", "maxTotal"), /maxTotal/);
});

test("a size whose bytes overflow exact range is refused", () => {
  // count * unit must stay a safe integer, the same ceiling duration.parse
  // carries; a size that overflows would silently change the configured bound.
  assert.throws(() => parse("999999999gb"), TypeError);
  assert.throws(() => parse("9007199254740993b"), TypeError);
  assert.throws(() => parse(Number.MAX_VALUE), TypeError);
  assert.throws(() => parse(2 ** 53), TypeError);
  // the ceiling itself still parses
  assert.equal(parse(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});
