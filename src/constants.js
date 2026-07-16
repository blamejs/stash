// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// @internal -- no operator-facing namespace. Operators pass human-readable
// forms ('24h', '100mb'); these are the scale facts those forms resolve
// through.
//
// constants -- the one home for scale and shape facts. A magnitude used by
// two modules is declared here once; nothing else in src/ multiplies its
// own time or byte literals (the raw-scale-literal detector enforces it).
// Frozen: a constant a caller can reassign is a config surface nobody
// audits.

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object") deepFreeze(value);
  }
  return Object.freeze(obj);
}

export const C = deepFreeze({
  TIME: {
    SECOND: 1000,
    MINUTE: 60 * 1000,
    HOUR: 60 * 60 * 1000,
    DAY: 24 * 60 * 60 * 1000,
    // The 2^31-1 ceiling Node's timers accept: a delay above it silently
    // wraps to ~1ms and fires in a busy loop (a TimeoutOverflowWarning +
    // backend hammering). A sweepInterval above this is a config error, not a
    // rounding; operators needing rarer sweeps call prune() on their own clock.
    MAX_TIMER_MS: 2147483647,
  },
  BYTES: {
    KIB: 1024,
    MIB: 1024 * 1024,
    GIB: 1024 * 1024 * 1024,
  },
  REF: {
    PREFIX: "v1_",
    RANDOM_BYTES: 32,
    // 32 bytes -> unpadded base64url
    ENCODED_LENGTH: 43,
  },
});
