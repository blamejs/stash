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

import { C } from "./constants.js";

// Every consumer resolves durations through parse() rather than
// multiplying its own literals; the scale facts live in constants.
const UNIT_MS = {
  s: C.TIME.SECOND,
  m: C.TIME.MINUTE,
  h: C.TIME.HOUR,
  d: C.TIME.DAY,
};

const DURATION_PATTERN = /^(\d+)(s|m|h|d)$/;

// parse(value, label) -> number(ms) | null | throws TypeError.
// @enforced-by raw-time-scale-literal
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
    const ms = Number(match[1]) * UNIT_MS[match[2]];
    // The number path demands a finite value; the computed path holds the
    // stronger exact-integer bound -- a count that overflows to Infinity or
    // sheds precision would silently change the configured terms.
    if (!Number.isSafeInteger(ms)) {
      throw new TypeError(label + ": duration overflows the exact millisecond range");
    }
    return ms;
  }
  throw new TypeError(label + ": expected a duration string, a number of milliseconds, or null");
}
