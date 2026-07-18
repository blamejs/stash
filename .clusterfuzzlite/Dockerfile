# Fuzz-build container (ClusterFuzzLite). The base image carries Node plus
# the oss-fuzz javascript build helpers; build.sh installs the fuzzing
# engine into this container only, so the library's zero-dependency rule
# (SPEC.md 2) holds everywhere outside it. The base is pinned by digest:
# oss-fuzz publishes it as a rolling :latest with no semver tags, so the
# digest is the only stable reference -- there is no version tag to note.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:649105c8df1de6b5e752aaad2c944198aba5cb79481b9ccbcaa189854d9f50d2
COPY . $SRC/stash
COPY ./.clusterfuzzlite/build.sh $SRC/build.sh
WORKDIR $SRC/stash
