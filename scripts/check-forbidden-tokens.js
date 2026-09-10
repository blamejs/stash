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
  // which module they reach.
  "getBuiltinModule",
  "createRequire",
  // A call to the CommonJS loader, in the spellings that reach it. `require`
  // is not defined in ESM, but a `.cjs` file added under src/ is CommonJS and
  // ships with the rest, so it is in scope there. The call shape is refused
  // whatever its target, which an allowlist reading specifiers cannot do:
  // `require(name)` names no module for it to check. The word boundary keeps
  // `_requireSidecarId(...)` and the prose "required" out of it.
  "\\brequire\\b\\s*\\(",
  "\\(\\s*require\\s*\\)\\s*\\(",
  // An identifier may be spelled with escapes -- `requ\\u0069re(...)` calls the
  // same function -- so a scan reading the name would not see it. src/ writes
  // its characters directly and holds no escape of this form.
  "\\\\u",
  // Code built at runtime is invisible to every check here: a scan reads what
  // the file says, and `eval("im" + "port(...)")` says nothing. The call shape
  // is matched, not the bare word, because `revalidated` contains one.
  "\\beval\\s*\\(",
  // Computed member access reaches a property without spelling its name, so
  // the tokens above can be assembled at runtime -- `process["getBuiltin" +
  // "Module"]`, or the same through an alias. Both forms are refused: any
  // bracket access on `process`, and any bracket access whose key is built by
  // concatenation. src/ names the properties it reads.
  "process\\[",
  "\\[\\s*[\"'][^\"']*[\"']\\s*\\+",
  "\\+\\s*[\"'][^\"']*[\"']\\s*\\]",
  // Key-bearing surfaces and the flags that widen them.
  "subtle",
  "webcrypto",
  "openssl-store",
  "node:sqlite",
  "password",
  "passphrase",
];

// Matched with case respected. The list above is case-insensitive, so that a
// `PASSWORD` or a `Decrypt` cannot slip past it, but the Function constructor
// differs from the `function` keyword only by case -- folding them together
// would report every function in the tree.
// The constructor is callable without `new`, and its body may arrive in a
// variable, so the call shape is matched whatever the argument is.
export const FORBIDDEN_TOKENS_EXACT = ["\\bnew\\s+Function\\b", "\\bFunction\\s*\\("];

export function forbiddenMatchers() {
  return [
    new RegExp(FORBIDDEN_TOKENS.join("|"), "i"),
    new RegExp(FORBIDDEN_TOKENS_EXACT.join("|")),
  ];
}

export function scanForbidden(files, read) {
  const matchers = forbiddenMatchers();
  const hits = [];
  for (const file of files) {
    const lines = read(file).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (matchers.some((re) => re.test(lines[i]))) {
        hits.push({ file, line: i + 1, text: lines[i].trim() });
      }
    }
  }
  return hits;
}

// Everything under src/ ships, since package.json packs the directory whole.
// Scanning only `.js` would leave a `.mjs`, a `.cjs`, or a file carrying no
// extension at all inside the tarball and outside every check here. Anything
// that is not a known non-code type is read.
const NOT_CODE = /\.(?:json|md|txt|map|png|svg|ico|woff2?|lock)$/i;

function srcFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (!NOT_CODE.test(p)) out.push(p);
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
    `[forbidden-tokens] ok -- ${files.length} file(s), ${FORBIDDEN_TOKENS.length + FORBIDDEN_TOKENS_EXACT.length} tokens, zero hits`,
  );
}
