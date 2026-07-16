// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../src/duration.js";

test("parses the documented duration forms", () => {
  assert.equal(parse("30m"), 30 * 60 * 1000);
  assert.equal(parse("24h"), 24 * 60 * 60 * 1000);
  assert.equal(parse("7d"), 7 * 24 * 60 * 60 * 1000);
  assert.equal(parse("45s"), 45 * 1000);
  assert.equal(parse("0s"), 0);
  assert.equal(parse(1500), 1500);
  assert.equal(parse(0), 0);
  assert.equal(parse(null), null);
  assert.equal(parse(undefined), null);
});

test("rejects malformed durations at config time", () => {
  const bad = ["24", "h24", "24H", "1.5h", "-1h", "24 h", "1w", "1y", "", "24hh", NaN, Infinity, -1, {}, [], true];
  for (const value of bad) {
    assert.throws(() => parse(value, "ttl"), TypeError);
  }
});

test("the label names the offending option", () => {
  assert.throws(() => parse("nope", "sweepInterval"), /sweepInterval/);
});

test("a duration whose milliseconds overflow exact range is refused", () => {
  // The number path demands a finite value; the string path computes
  // count * unit and must hold the same bound. An overflowing count that
  // lands on Infinity or sheds precision would silently change the
  // operator's terms instead of failing at boot.
  assert.throws(() => parse("9".repeat(400) + "s"), TypeError);
  assert.throws(() => parse("9007199254740993s"), TypeError);
  // the largest exact product still parses
  assert.equal(parse("104249991d"), 104249991 * 24 * 60 * 60 * 1000);
});

test("a numeric duration must be a non-negative safe integer, not merely finite", () => {
  // A fractional ms or a value past 2^53-1 would make expiresAt = createdAt +
  // ms a non-safe integer -- serialized as a lie or an integrity verdict on
  // every later read. The number branch rejects both at config time.
  assert.throws(() => parse(1500.5), TypeError);
  assert.throws(() => parse(Number.MAX_VALUE), TypeError);
  assert.throws(() => parse(2 ** 53), TypeError); // 2^53 is not a safe integer
  assert.equal(parse(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER); // the ceiling still parses
});
