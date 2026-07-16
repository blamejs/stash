// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// @internal -- no operator-facing namespace. The documented surface is the
// TypeError each public method throws at config time; this is the one
// mechanism behind all of them.
//
// validate -- config-time input-shape validation, defined ONCE.
//
// The policy layer names WHICH options a method accepts and which are
// fail-loud placeholders for an unshipped milestone; this module owns HOW
// that is enforced, so the reject-unknown / reject-unimplemented mechanics
// cannot drift apart across methods (an option whitelist that one method
// forgets is a silent fail-open).

// plainObject(value, label) -> value | throws TypeError.
// @enforced-by validator-shape-reinlined
// @validator-shape expected a plain object
export function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + ": expected a plain object");
  }
  return value;
}

// options(opts, label, spec) -> opts | throws TypeError.
// spec.allowed: keys the method accepts today. spec.unimplemented: keys
// SPEC.md defines whose milestone has not shipped -- each throws rather
// than sitting silently unenforced.
// @enforced-by validator-shape-reinlined
// @validator-shape unknown option
export function options(opts, label, spec) {
  plainObject(opts, label);
  for (const key of spec.unimplemented || []) {
    if (key in opts) {
      throw new TypeError(
        label + ": option '" + key + "' is not implemented yet (SPEC.md 12 is the delivery plan)"
      );
    }
  }
  for (const key of Object.keys(opts)) {
    if (!spec.allowed.includes(key)) {
      throw new TypeError(label + ": unknown option '" + key + "'");
    }
  }
  return opts;
}
