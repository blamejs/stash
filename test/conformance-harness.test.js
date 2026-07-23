// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// The shipped conformance harness (@blamejs/stash/conformance) certifies a
// backend against the SPEC.md 9 contract. Two things are proven here:
//
//   1. It is TEST-RUNNER-AGNOSTIC. `runBackendConformance` is driven below by
//      a hand-rolled collector -- NOT node:test -- and still registers and runs
//      its cases. A third party on any runner wires their own `test` the same way.
//   2. It CATCHES a non-conforming backend. A conforming backend yields zero
//      failures (GREEN); a backend that silently drops bytes on write, or serves
//      tampered bytes on read, produces failures (RED). A harness that could not
//      fail a bad backend would certify nothing.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { runBackendConformance } from "../src/conformance.js";
import { BACKENDS, wrapBackend, corruptingReadBackend } from "./_helpers.js";
import { cleanupScratch } from "./_scratch.js";

after(() => cleanupScratch());

// runCollecting(factory) -> [{ name, ok, err? }]. Drive the harness with a
// hand-rolled test collector (no node:test): the harness registers each case
// synchronously via the injected `test`, then we run them and record the
// verdicts. This is both the runner-agnostic proof and the vehicle for the
// RED/GREEN checks -- a conforming backend records every case ok, a broken one
// records at least one failure.
async function runCollecting(factory) {
  const cases = [];
  const test = (name, fn) => cases.push({ name, fn });
  runBackendConformance(factory, { test }); // assert defaults to node:assert/strict
  const results = [];
  for (const c of cases) {
    try {
      await c.fn();
      results.push({ name: c.name, ok: true });
    } catch (err) {
      results.push({ name: c.name, ok: false, err });
    }
  }
  return results;
}

// dropFirstByte(source) -- an async-iterable that silently loses the first
// stored byte: the "backend drops bytes" fault the round-trip fidelity cases
// exist to catch. The digest is computed by write() over what actually lands,
// so integrity verification alone would NOT notice -- only comparing the bytes
// out against the bytes in does.
async function* dropFirstByte(source) {
  let dropped = false;
  for await (const chunk of source) {
    const buf = Buffer.from(chunk);
    if (!dropped && buf.length > 0) {
      dropped = true;
      if (buf.length > 1) yield buf.subarray(1);
    } else {
      yield buf;
    }
  }
}

// A non-conforming backend: write stores one byte fewer than it was handed.
function droppingWriteBackend(inner) {
  return wrapBackend(inner, {
    write: (id, source, entry) => inner.write(id, dropFirstByte(source), entry),
  });
}

for (const { name, create } of BACKENDS) {
  // GREEN: the shipped backends pass their own contract, driven by a foreign runner.
  test("the harness certifies the in-tree " + name + " backend with a foreign runner", async () => {
    const results = await runCollecting({ name, create });
    assert.ok(results.length >= 20, "the harness registered its full core (" + results.length + " cases)");
    const failed = results.filter((r) => !r.ok);
    assert.deepEqual(
      failed.map((f) => f.name),
      [],
      "a conforming backend passes every case" + (failed[0] ? " -- first failure: " + failed[0].err : ""),
    );
  });

  // RED: silent data loss on write is caught by the round-trip fidelity cases.
  test("the harness CATCHES a " + name + " backend that silently drops bytes on write", async () => {
    const results = await runCollecting({ name: "dropping-" + name, create: () => droppingWriteBackend(create()) });
    const failed = results.filter((r) => !r.ok);
    assert.ok(failed.length > 0, "silent data loss must fail at least one case, not certify clean");
    assert.ok(
      failed.some((f) => f.name.includes("round-trips a Buffer")),
      "the Buffer round-trip is one of the failures",
    );
  });

  // RED: tampered bytes on read are caught (digest verification -> the case rejects).
  test("the harness CATCHES a " + name + " backend that serves tampered bytes on read", async () => {
    const results = await runCollecting({ name: "corrupting-" + name, create: () => corruptingReadBackend(create()) });
    const failed = results.filter((r) => !r.ok);
    assert.ok(failed.length > 0, "a read that returns tampered bytes must fail the suite");
  });
}

// Guard the input contract: the harness fails loud on a missing runner or a
// malformed factory rather than silently registering nothing.
test("runBackendConformance rejects a missing test runner and a malformed factory", () => {
  assert.throws(() => runBackendConformance({ name: "x", create: () => new Object() }, {}), TypeError);
  assert.throws(() => runBackendConformance({ name: "x", create: () => new Object() }), TypeError);
  assert.throws(() => runBackendConformance({ name: "x" }, { test: () => {} }), TypeError);
  assert.throws(() => runBackendConformance(null, { test: () => {} }), TypeError);
});
