// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
import { test } from "node:test";
import assert from "node:assert/strict";

import { oneOf, options, plainObject } from "../src/validate.js";

test("plainObject accepts an object bag and refuses null, non-objects, and arrays", () => {
  const ok = { a: 1 };
  assert.equal(plainObject(ok, "opts"), ok);
  // A null-prototype bag is accepted: it is the SAFER shape for an options object
  // (no inherited keys to confuse a whitelist), so the guard must not refuse it.
  const bare = Object.create(null);
  assert.equal(plainObject(bare, "opts"), bare);
  for (const bad of [null, undefined, 42, "s", true, [], () => {}]) {
    assert.throws(() => plainObject(bad, "opts"), TypeError);
  }
});

test("plainObject's bar is object-ness, not plain-ness -- an exotic object passes", () => {
  // The check is `not null && typeof === "object" && not an Array`, so a Date, a Map,
  // or a RegExp is accepted. That is deliberate latitude, not an oversight: this guard
  // exists to stop a non-bag (a number, a string, an array) from being treated as an
  // options object, and the per-key whitelist immediately after is what actually
  // decides which keys may appear. Pinned so a future tightening is a conscious
  // decision with a failing test, rather than a silent behavior change.
  for (const exotic of [new Date(), new Map(), /re/, new Error("x")]) {
    assert.equal(plainObject(exotic, "opts"), exotic);
  }
});

test("plainObject's message names the offending label", () => {
  assert.throws(() => plainObject(null, "new Stash: backend"), /new Stash: backend/);
});

test("options accepts exactly the allowed keys and returns the same object", () => {
  const opts = { meta: {}, ttl: "1h" };
  assert.equal(options(opts, "push", { allowed: ["meta", "ttl", "reads"] }), opts);
  const empty = {};
  assert.equal(options(empty, "push", { allowed: [] }), empty);
});

test("options refuses an unknown key and names it", () => {
  assert.throws(() => options({ nope: 1 }, "push", { allowed: ["meta"] }), TypeError);
  assert.throws(() => options({ nope: 1 }, "push", { allowed: ["meta"] }), /unknown option 'nope'/);
  assert.throws(() => options({ nope: 1 }, "push", { allowed: ["meta"] }), /push/);
});

// The reject-unimplemented tier (hard rule 3): a spec'd option whose milestone has
// not shipped THROWS at config time rather than sitting accepted-but-unenforced,
// which would be fail-open by shape. The shipped option surface is complete today,
// so every caller passes an empty list and no consumer path reaches this branch --
// these vectors pin the mechanism's contract directly so it cannot rot while it
// waits for the next spec'd-but-unshipped option.
test("options rejects a spec'd-but-unshipped option ahead of the unknown-key check", () => {
  const spec = { allowed: ["meta"], unimplemented: ["encrypt"] };
  assert.throws(() => options({ encrypt: true }, "push", spec), TypeError);
  assert.throws(() => options({ encrypt: true }, "push", spec), /not implemented yet/);
  assert.throws(() => options({ encrypt: true }, "push", spec), /encrypt/);
});

test("an unimplemented option is refused even when it is also allowed", () => {
  // The unimplemented sweep runs BEFORE the allowed-key check, so a key present in
  // both lists still throws the unimplemented verdict -- an option cannot be
  // half-shipped by listing it in `allowed` before its milestone lands.
  const spec = { allowed: ["meta", "encrypt"], unimplemented: ["encrypt"] };
  assert.throws(() => options({ encrypt: true }, "push", spec), /not implemented yet/);
});

test("an absent unimplemented option does not trip the check", () => {
  const spec = { allowed: ["meta"], unimplemented: ["encrypt"] };
  const opts = { meta: {} };
  assert.equal(options(opts, "push", spec), opts);
});

test("oneOf accepts a member and refuses a non-member, naming the label", () => {
  assert.equal(oneOf("restore", "new Stash: onPopFailure", ["restore", "burn"]), "restore");
  assert.throws(() => oneOf("nope", "new Stash: onPopFailure", ["restore", "burn"]), TypeError);
  assert.throws(() => oneOf("nope", "new Stash: onPopFailure", ["restore", "burn"]), /new Stash: onPopFailure/);
});
