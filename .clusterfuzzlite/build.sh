#!/bin/bash -eu
# ClusterFuzzLite build: compile the fuzz targets and package their seed
# corpora. Runs only inside the fuzz-build container.

cd "$SRC/stash"

# The engine is a container-local install: --no-save and --no-package-lock
# keep the manifest and lockfile untouched, so the library stays
# zero-dependency (SPEC.md 2). .npmrc sets engine-strict against the
# package's Node floor, which the container's Node line may trail; the
# check is meaningful for consumers, not for this throwaway install, so it
# is relaxed here only.
npm install --no-save --no-package-lock --no-engine-strict @jazzer.js/core@2.1.0

# Each target compiles to $OUT/<basename>; its seed corpus rides along as
# $OUT/<basename>_seed_corpus.zip.
compile_javascript_fuzzer stash .clusterfuzzlite/fuzz_digest.js
zip -j "$OUT/fuzz_digest_seed_corpus.zip" .clusterfuzzlite/seeds/fuzz_digest/*

compile_javascript_fuzzer stash .clusterfuzzlite/fuzz_ref.js
zip -j "$OUT/fuzz_ref_seed_corpus.zip" .clusterfuzzlite/seeds/fuzz_ref/*

compile_javascript_fuzzer stash .clusterfuzzlite/fuzz_sidecar.js
zip -j "$OUT/fuzz_sidecar_seed_corpus.zip" .clusterfuzzlite/seeds/fuzz_sidecar/*

compile_javascript_fuzzer stash .clusterfuzzlite/fuzz_tombstone.js
zip -j "$OUT/fuzz_tombstone_seed_corpus.zip" .clusterfuzzlite/seeds/fuzz_tombstone/*
