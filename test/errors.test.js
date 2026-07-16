// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  StashError,
  RefNotFound,
  RefClaimed,
  IntegrityError,
  SizeExceeded,
  StashFull,
  InvalidRef,
} from "../src/errors.js";

const TABLE = [
  [RefNotFound, "ENOREF"],
  [RefClaimed, "ECLAIMED"],
  [IntegrityError, "EINTEGRITY"],
  [SizeExceeded, "E2BIG"],
  [StashFull, "EFULL"],
  [InvalidRef, "EBADREF"],
];

test("every error is typed with its frozen code", () => {
  for (const [Cls, code] of TABLE) {
    const err = new Cls();
    assert.ok(err instanceof Cls);
    assert.ok(err instanceof StashError);
    assert.ok(err instanceof Error);
    assert.equal(err.code, code);
    assert.equal(err.name, Cls.name);
    assert.ok(err.message.length > 0);
  }
});

test("default messages carry no ref, meta value, or path", () => {
  for (const [Cls] of TABLE) {
    const message = new Cls().message;
    assert.doesNotMatch(message, /v1_[A-Za-z0-9_-]{43}/);
    assert.doesNotMatch(message, /[\\/]/);
  }
});
