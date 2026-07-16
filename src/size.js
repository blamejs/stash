// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// @internal -- no operator-facing namespace. Constructor byte bounds
// ('100mb', '1gb') are parsed here; operators never call this module directly.
//
// size -- parse a human byte size into a count of bytes.
//
// Accepted forms: a non-negative safe integer (already bytes), a string of the
// shape <count><unit> with unit one of b / kb / mb / gb, or null / undefined
// (meaning "no size" -> null). Anything else is a TypeError at config time -- a
// mistyped bound must fail at boot, not silently disable the limit.
//
// A sibling to duration.js, deliberately NOT an extension of it: time and byte
// magnitudes are distinct domains, and their unit letters collide ('m' is
// minutes there, 'mb' is megabytes here), so overloading one parser would make
// '100m' ambiguous. Same shape, same safe-integer ceiling, its own scale table.

import { C } from "./constants.js";

// Every consumer resolves byte sizes through parse() rather than multiplying
// its own literals; the scale facts live in constants (`b` is scale 1).
const UNIT_BYTES = {
  b: 1,
  kb: C.BYTES.KIB,
  mb: C.BYTES.MIB,
  gb: C.BYTES.GIB,
};

const SIZE_PATTERN = /^(\d+)(b|kb|mb|gb)$/;

// parse(value, label) -> number(bytes) | null | throws TypeError.
// @enforced-by raw-time-scale-literal
export function parse(value, label = "size") {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    // A safe integer, not merely finite: a fractional or over-range byte count
    // cannot be a real limit, and it would poison a `count > bound` compare.
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(label + ": expected a non-negative integer number of bytes");
    }
    return value;
  }
  if (typeof value === "string") {
    const match = SIZE_PATTERN.exec(value);
    if (match === null) {
      throw new TypeError(label + ": expected a size like '64b', '512kb', '100mb', or '1gb'");
    }
    const bytes = Number(match[1]) * UNIT_BYTES[match[2]];
    // The computed path holds the same exact-integer bound the number path
    // demands: a count that overflows the safe range would silently change the
    // configured bound.
    if (!Number.isSafeInteger(bytes)) {
      throw new TypeError(label + ": size overflows the exact byte range");
    }
    return bytes;
  }
  throw new TypeError(label + ": expected a size string, a number of bytes, or null");
}
