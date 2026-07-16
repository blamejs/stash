<!--
Thanks for the PR! Fill in the sections below. CI (gates + suite +
sandboxed suite) is required to pass before merge -- local pre-flight:

  node test/codebase-patterns.test.js
  node scripts/validate-source-comment-blocks.js
  node scripts/check-api-snapshot.js
  node --test
  node scripts/run-sandboxed.js

Security-sensitive patches: don't open here, see SECURITY.md.
-->

## Summary

<!-- One or two sentences. What does this change and why. -->

## Type of change

<!-- Check all that apply -->

- [ ] Bug fix (no API change)
- [ ] New store capability / backend behavior
- [ ] Docs / SPEC / CHANGELOG update
- [ ] Test coverage / CI improvement
- [ ] Refactor (no behavior change)
- [ ] Other:

## Linked issue

Closes #

## House rules checklist (SPEC.md sections 1-3)

- [ ] Zero dependencies, dev included -- Node builtins only (SPEC.md section 2)
- [ ] No cipher construction, no `node:sqlite`, no `password` token anywhere under `src/` (SPEC.md sections 1, 3, and 13.1 invariant 1)
- [ ] `node:crypto` usage limited to `createHash`, `randomBytes`, `timingSafeEqual` (SPEC.md section 1)
- [ ] ESM, plain JavaScript, no build step, no transpilation (SPEC.md section 2)
- [ ] Streaming-first: no method buffers an entire blob; size limits enforced mid-stream (SPEC.md section 2)
- [ ] Not on the "Do not build these" list (SPEC.md section 3) -- no dedup, no compression, no eviction, no namespaces, no content inspection
- [ ] Errors are typed with the frozen `.code` set (`ENOREF`, `ECLAIMED`, `EINTEGRITY`, `E2BIG`, `EFULL`, `EBADREF`); no error message contains a ref, a `meta` value, or a path (SPEC.md section 10)
- [ ] No ref or `meta` content in any log line -- a ref is a capability (SPEC.md section 3)

## Tests

- [ ] `node --test` passes
- [ ] `node scripts/run-sandboxed.js` passes -- the suite is green under `--permission` scoped to the test root (SPEC.md 13.1 invariant 2)
- [ ] New tests added for the new behavior (failing before the fix, passing after)
- [ ] Behavior exercised against BOTH backends via the shared conformance suite, if it touches storage (SPEC.md section 13)

## Documentation

- [ ] CHANGELOG.md entry under the relevant `## vX.Y.Z`
- [ ] SPEC.md updated if the public surface or an invariant changed
- [ ] README.md updated if the capability appears in the high-level pitch
- [ ] Commit message explains *why* and *what tradeoff*, not just *what*

## Behavior changes

<!-- If this PR changes existing behavior (output shape, error code,
default value, accepted-input set), call it out so the next release
notes can flag it. -->

## Open questions / reviewer focus
