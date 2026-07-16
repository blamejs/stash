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

// The frozen field set, in canonical order. M2's sidecar codec derives
// its accept-list from THIS array, not a second copy.
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
