// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// check-forbidden-tokens -- SPEC.md 1 / 13.1 invariant 1: no key machinery,
// no sqlite, no password surface in src/.
//
// The store's guarantee is architectural. There is nowhere in the source for a
// key to live, so the tokens that would put one there are refused outright,
// comments included: a commented-out cipher call is a hole being sketched.
//
// The list lives HERE and nowhere else. It was previously written out in the
// pattern detector and again in each workflow that greps for it, and when the
// list grew, one of those copies was left behind still checking the old tokens
// -- a gate reporting green against a rule that had moved. The detector
// imports FORBIDDEN_TOKENS from this file and both workflows run this script,
// so there is one list to change.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const FORBIDDEN_TOKENS = [
  // Cipher machinery, and the operations that consume a key directly.
  "createCipheriv",
  "createDecipheriv",
  "createCipher\\b",
  "createDecipher\\b",
  "decrypt",
  "privateEncrypt",
  "publicEncrypt",
  // Key material: ingestion, generation, derivation, agreement. A store that
  // cannot decrypt must also have nowhere to OBTAIN a key -- Node 24.21.0
  // added `createPrivateKey({ URL })` backed by an OpenSSL STORE loader, whose
  // reads are not constrained by the fs.read / fs.write permission scopes, so
  // an ingestion token is not reachable by the fs sandbox alone.
  "createPrivateKey",
  "createPublicKey",
  "createSecretKey",
  "createHmac",
  "generateKey",
  "importKey",
  "unwrapKey",
  "wrapKey",
  "deriveKey",
  "deriveBits",
  "createDiffieHellman",
  "diffieHellman",
  "createECDH",
  "createSign",
  "createVerify",
  "hkdf",
  "pbkdf2",
  "scrypt",
  // Loaders that take a module name as a value, so no import allowlist can see
  // which module they reach. `process[` covers computed access to the first.
  "getBuiltinModule",
  "createRequire",
  "process\\[",
  // Key-bearing surfaces and the flags that widen them.
  "subtle",
  "webcrypto",
  "openssl-store",
  "node:sqlite",
  "password",
  "passphrase",
];

export function scanForbidden(files, read) {
  const re = new RegExp(FORBIDDEN_TOKENS.join("|"), "i");
  const hits = [];
  for (const file of files) {
    const lines = read(file).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) hits.push({ file, line: i + 1, text: lines[i].trim() });
    }
  }
  return hits;
}

function srcFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = srcFiles(join(ROOT, "src"));
  if (files.length === 0) {
    console.error("[forbidden-tokens] src/ walk found no files -- the check would be vacuous");
    process.exit(1);
  }
  const hits = scanForbidden(files, (f) => readFileSync(f, "utf8"));
  if (hits.length > 0) {
    for (const h of hits) {
      console.error(`::error file=${h.file},line=${h.line}::forbidden token: ${h.text}`);
    }
    process.exit(1);
  }
  console.log(
    `[forbidden-tokens] ok -- ${files.length} file(s), ${FORBIDDEN_TOKENS.length} tokens, zero hits`,
  );
}
