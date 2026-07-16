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
