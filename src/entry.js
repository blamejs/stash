// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// @internal -- no operator-facing namespace. Operators receive entries from
// show()/list(); this module is where their one canonical shape lives.
//
// entry -- the canonical Entry structure (SPEC.md 4), defined ONCE.
//
// One structure, both directions: every path that constructs an entry
// (push today; the disk backend's meta read at M2, store()'s replication
// input at M7) composes this module, so the writer's shape and a reader's
// validation can never diverge. A second Entry construction site is the
// bug class this file exists to prevent -- the readsLeft field-literal
// shape is detector-enforced.

import { isValid } from "./ref.js";

// The frozen field set, in canonical order. The sidecar codec derives its
// accept-list from THIS array, not a second copy.
export const FIELDS = Object.freeze([
  "id",
  "size",
  "digest",
  "createdAt",
  "expiresAt",
  "reads",
  "readsLeft",
  "meta",
]);

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function _isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function _isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// assertShape(value, ErrorClass) -> value | throws new ErrorClass(...).
// The read direction of the canonical shape: a STORED entry (a disk
// sidecar, a replicated insert) must carry exactly the FIELDS set with
// every field well-typed -- extra keys, missing keys, or a type drift are
// the caller's verdict class, never a partially-trusted object. Messages
// name the failing FIELD, never a value: field names are contract, values
// are capabilities.
// @enforced-by behavioral -- the hostile-sidecar battery drives every
//   rejection branch through the shipped read path; the shape itself has
//   no rename-proof code signature apart from entry.make's, which the
//   guard detector already owns.
export function assertShape(value, ErrorClass) {
  if (!_isPlainObject(value)) throw new ErrorClass("stored entry rejected: not an object");
  const keys = Object.keys(value);
  if (keys.length !== FIELDS.length) throw new ErrorClass("stored entry rejected: field set");
  for (const field of FIELDS) {
    if (!(field in value)) throw new ErrorClass("stored entry rejected: field set");
  }
  if (!isValid(value.id)) throw new ErrorClass("stored entry rejected: id");
  if (!_isCount(value.size)) throw new ErrorClass("stored entry rejected: size");
  if (typeof value.digest !== "string" || !DIGEST_PATTERN.test(value.digest)) {
    throw new ErrorClass("stored entry rejected: digest");
  }
  if (!_isCount(value.createdAt)) throw new ErrorClass("stored entry rejected: createdAt");
  if (value.expiresAt !== null && !_isCount(value.expiresAt)) {
    throw new ErrorClass("stored entry rejected: expiresAt");
  }
  const budgeted = value.reads !== null;
  if (budgeted && !(Number.isSafeInteger(value.reads) && value.reads > 0)) {
    throw new ErrorClass("stored entry rejected: reads");
  }
  if (budgeted !== (value.readsLeft !== null)) {
    throw new ErrorClass("stored entry rejected: read budget coherence");
  }
  if (budgeted && (!_isCount(value.readsLeft) || value.readsLeft > value.reads)) {
    throw new ErrorClass("stored entry rejected: readsLeft");
  }
  if (!_isPlainObject(value.meta)) throw new ErrorClass("stored entry rejected: meta");
  return value;
}

// make(id, meta) -> a fresh M1 entry. Size and digest are the backend's to
// fill during the write stream; lifecycle fields start at their inert
// values (no TTL, no budget) until the milestones that enforce them ship.
// @enforced-by guard-shape-reinlined
// @guard-shape readsLeft\s*:
export function make(id, meta) {
  return {
    id,
    size: 0,
    digest: null,
    createdAt: Date.now(),
    expiresAt: null,
    reads: null,
    readsLeft: null,
    meta,
  };
}
