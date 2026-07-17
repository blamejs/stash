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
// Strict input validation of stored bytes (CWE-20; the sidecar is RFC 8259
// JSON). The read direction of the canonical shape: a STORED entry (a disk
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

// isExpired(entry, nowMs) -> boolean. The ONE expiry comparator: a null
// expiresAt never expires; otherwise the entry is expired once `nowMs` reaches
// its deadline. The boundary is `<=`, not `<` -- an entry whose deadline is the
// current instant IS expired, which is what makes a `ttl: 0` push deterministic
// (expired at birth, no clock-race in the tests). Every read verb's lazy gate,
// list's filter, and prune() route their expiry decision through here so a
// second relational comparison of `.expiresAt` can never drift from this one.
// @enforced-by guard-shape-reinlined
// @guard-shape \.expiresAt\s*[<>]
export function isExpired(entry, nowMs) {
  return entry.expiresAt !== null && entry.expiresAt <= nowMs;
}

// make(id, meta, ttlMs, reads) -> a fresh entry. Size and digest are the
// backend's to fill during the write stream. `ttlMs` (null = no expiry) stamps
// `expiresAt` from the SAME `createdAt` clock read, so the two can never come
// from two different reads. The sum must land on a safe integer -- an expiresAt
// past 2^53-1 serializes as a lie (JSON turns a non-finite into null = "never
// expires") or manufactures an integrity verdict on every later read -- so a
// ttl that overflows it is a config-time TypeError, caught here at the single
// construction site. `reads` (null = unlimited) is the read budget; a budgeted
// entry initializes `readsLeft` equal to `reads`, and both travel together
// through the sidecar so a reader can never see one without the other. A
// non-positive or non-integer budget is a config-time TypeError, at the same
// single site.
// @enforced-by guard-shape-reinlined
// @guard-shape readsLeft\s*:
export function make(id, meta, ttlMs = null, reads = null) {
  const createdAt = Date.now();
  let expiresAt = null;
  if (ttlMs !== null) {
    expiresAt = createdAt + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new TypeError("push: ttl places expiresAt beyond the safe integer range");
    }
  }
  if (reads !== null && !(Number.isSafeInteger(reads) && reads > 0)) {
    throw new TypeError("push: reads must be a positive integer or null");
  }
  return {
    id,
    size: 0,
    digest: null,
    createdAt,
    expiresAt,
    reads,
    readsLeft: reads,
    meta,
  };
}

// spend(entry) -> a COPY with `readsLeft` decremented by one. The monotone
// read-budget debit (SPEC.md 4.1, 4.2), owned by the schema home so no backend
// hand-rolls `readsLeft` arithmetic -- the guard-shape tripwire keeps the field
// literal here. It never mutates its argument (structuredClone discipline). A
// caller contract, not hostile input: spending an unbudgeted entry, or one with
// no credit left, is a TypeError -- never a silent no-op that would let a
// budgeted entry outlive its budget. The decrement is only ever applied while
// the caller holds the entry's claim, which is the cross-process mutex.
// @enforced-by guard-shape-reinlined
// @guard-shape readsLeft\s*:
export function spend(entry) {
  if (entry.readsLeft === null) throw new TypeError("spend: entry has no read budget");
  if (entry.readsLeft === 0) throw new TypeError("spend: read budget already exhausted");
  return { ...entry, readsLeft: entry.readsLeft - 1 };
}
