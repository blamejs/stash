# syntax=docker/dockerfile:1.7
#
# Chainguard (Wolfi) image for the stashjs.com documentation site.
#
# Build context = repo ROOT, not examples/wiki/: the site generates every
# page at boot from the library's own `src/*.js` @module / @primitive
# comment blocks (see examples/wiki/lib/page-generator + site.config's
# LIB_DIR -> ../../src), so the Dockerfile copies both `src/` and
# `examples/wiki/`. Compose in this directory sets `context: ../..`.
#
# The site is stateless and zero-dependency -- no database, no npm install,
# no build step. Pages are a pure function of the source, so the runtime
# image just carries the source and serves it. That keeps the image tiny
# and the attack surface minimal.
#
# Base image is digest-pinned (tag@sha256) for reproducible local builds
# and supply-chain provenance. release-container.yml resolves the rolling
# `:latest` tag to a FRESH digest at build time and passes it via the
# BASE_RUNTIME build-arg (so the scanned image == the published one and
# always carries current CVE patches). A `docker build` with no build-args,
# including a deploy platform building from this file, uses the pinned
# default below, and the Node it runs is whatever that digest carries.
# Dependabot does not update a digest in an ARG default, so the pin moves
# only when edited here. CI runs `node scripts/check-node-pins.js --image`,
# which fails when the pinned image's Node does not satisfy `engines.node`.
# To move it: docker buildx imagetools inspect cgr.dev/chainguard/node:latest
ARG BASE_RUNTIME=cgr.dev/chainguard/node:latest@sha256:6cb70d6b2a324e491263949ea9f58938ed19031ef478e0bdb0b1810f96f8b400

FROM ${BASE_RUNTIME} AS runtime

# Chainguard's :latest already runs as `nonroot` (UID 65532); Trivy's
# static Dockerfile checker (DS-0002) flags any image without an explicit
# USER line regardless of the base default, so restate it.
USER 65532:65532

# Non-secret defaults baked into the image. WIKI_PORT MUST agree with
# EXPOSE / HEALTHCHECK below and with release-container.yml's smoke `-p`
# and /healthz curl -- the codebase-patterns wiki-port-cross-artifact-drift
# detector gates that.
ENV NODE_ENV=production \
    WIKI_PORT=3011 \
    WIKI_BIND=0.0.0.0 \
    WIKI_SITE_URL=https://stashjs.com

WORKDIR /app
# The library source the page generator parses, then the site itself.
COPY --chown=65532:65532 src ./src
# README.md and SPEC.md sit at the repo root, ABOVE both trees above; the page
# generator resolves each as path.resolve(libDir, "..", "<name>") -- the README
# backs the Overview page (the site's front door), SPEC.md the Specification
# page. Without them the reads throw, the pages are dropped, and the front door
# ships blank -- so copy both into the same /app the generator resolves against.
COPY --chown=65532:65532 README.md ./README.md
COPY --chown=65532:65532 SPEC.md ./SPEC.md
COPY --chown=65532:65532 examples/wiki ./examples/wiki

WORKDIR /app/examples/wiki
EXPOSE 3011
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.WIKI_PORT || 3011) + '/healthz').then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})"]

# The Chainguard node image's ENTRYPOINT is ["/usr/bin/node"], so CMD is
# just the script path.
CMD ["server.js"]
