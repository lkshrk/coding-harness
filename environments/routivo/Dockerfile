# renovate: datasource=docker depName=node
FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS warm

ENV COREPACK_HOME=/tmp/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_AUTO_PIN=0 \
    npm_config_store_dir=/var/cache/nightshift/pnpm-store \
    pnpm_config_store_dir=/var/cache/nightshift/pnpm-store \
    npm_config_cache_dir=/var/cache/nightshift/pnpm-cache \
    pnpm_config_cache_dir=/var/cache/nightshift/pnpm-cache \
    CI=1

WORKDIR /warm/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml frontend/.npmrc ./
COPY frontend/patches ./patches
RUN corepack pnpm install --frozen-lockfile --ignore-scripts \
  && rm -rf node_modules

COPY frontend/project.inlang/settings.json /warm/inlang-settings.json
COPY .devcontainer/inlang-plugins.mjs /warm/
RUN node /warm/inlang-plugins.mjs /warm/inlang-settings.json /var/cache/nightshift/inlang/plugins \
  && chmod -R a+rwX /var/cache/nightshift

FROM debian:trixie@sha256:9cc080028c43b27d2074d63a5f9caf7166d731494965616c1a6d2827a004585c
COPY --from=warm /var/cache/nightshift /var/cache/nightshift
