# Deploying the stashjs.com docs site

The documentation site is a **stateless, zero-dependency** container: every
page is generated at boot from the library's `src/` `@module` /
`@primitive` comment blocks. There is no database, no admin login, no
writable state — a restart or a fresh image always reflects the current
source. That makes deployment simple and the runtime hardened (nonroot,
all capabilities dropped, no persistent data to protect).

The container listens on **port 3011** (`WIKI_PORT`).

## Run it locally

```sh
cd examples/wiki
docker compose up --build
# -> http://localhost:3011
```

`docker compose` builds from the repo root (the site needs the library
`src/` to generate its pages) and serves on 3011. Health: `GET /healthz`
returns `{"status":"ok"}`.

## Production (TLS on stashjs.com)

The production overlay pulls the published GHCR image and puts Caddy in
front for automatic Let's Encrypt TLS:

```sh
cd examples/wiki
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Point `stashjs.com` and `www.stashjs.com` A/AAAA records at the host, open
`80`/`443` inbound, and Caddy issues certificates on first boot. Caddy
forwards to the wiki container on the internal network — the wiki port is
never exposed on the host. See `Caddyfile` for the reverse-proxy config.

## Environment variables

| Variable        | Default               | Purpose                                  |
|-----------------|-----------------------|------------------------------------------|
| `WIKI_PORT`     | `3011`                | HTTP listen port                         |
| `WIKI_BIND`     | `0.0.0.0`             | Bind address                             |
| `WIKI_SITE_URL` | `https://stashjs.com` | Canonical public URL used in page markup |
| `WIKI_IMAGE_TAG` | pinned per release   | Published image tag the prod overlay pulls (set in `.env` to upgrade) |

No secrets are ever baked into the image.

## Published image

`ghcr.io/blamejs/stash-wiki` — multi-arch (`linux/amd64`, `linux/arm64`),
built, Trivy-scanned, and cosign-signed on every `v*` tag by
`.github/workflows/release-container.yml`. The base image is a
digest-pinned Chainguard (Wolfi) node image, resolved to a fresh digest at
build time so the scanned image is the published image.

## Updating

The site tracks the source: a new library release republishes the image
with the current API surface. To refresh a running production deployment,
`docker compose pull && docker compose up -d`.
