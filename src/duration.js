// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// @internal -- no operator-facing namespace. Constructor and push options
// ('24h', '30m', '7d') are parsed here; operators never call this module
// directly.
//
// duration -- parse a human duration into milliseconds.
//
// Accepted forms: a non-negative finite number (already ms), a string of
// the shape <count><unit> with unit one of s / m / h / d, or null /
// undefined (meaning "no duration" -> null). Anything else is a TypeError
// at config time -- a mistyped TTL should fail at boot, not silently
// become "no expiry".

// The time scale lives here and only here; every consumer resolves
// durations through parse() rather than multiplying its own literals.
const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

const DURATION_PATTERN = /^(\d+)(s|m|h|d)$/;

// parse(value, label) -> number(ms) | null | throws TypeError.
export function parse(value, label = "duration") {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(label + ": expected a non-negative finite number of milliseconds");
    }
    return value;
  }
  if (typeof value === "string") {
    const match = DURATION_PATTERN.exec(value);
    if (match === null) {
      throw new TypeError(label + ": expected a duration like '30m', '24h', or '7d'");
    }
    return Number(match[1]) * UNIT_MS[match[2]];
  }
  throw new TypeError(label + ": expected a duration string, a number of milliseconds, or null");
}
