# renovate: datasource=docker depName=ghcr.io/astral-sh/uv
FROM ghcr.io/astral-sh/uv:0.12.23@sha256:61d393e44e249f2e4b526b6c7ddcecce245946826e608e11c93ad4f5bba55b21 AS uv

# renovate: datasource=docker depName=node
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS warm

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

FROM debian:trixie@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5 AS warm-backend

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates libhdf5-dev build-essential pkg-config \
  && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /usr/local/bin/uv

ENV UV_CACHE_DIR=/var/cache/nightshift/uv \
    UV_PYTHON_INSTALL_DIR=/tmp/python \
    UV_LINK_MODE=copy \
    UV_NO_BINARY_PACKAGE=h5py

WORKDIR /warm/backend
COPY backend/pyproject.toml backend/uv.lock backend/.python-versio[n] ./
# Only the manifests are copied so source edits do not rebuild; the build backend is cached for the offline project install.
RUN uv sync --frozen --no-install-project \
  && .venv/bin/python -c 'import tomllib; print("\n".join(tomllib.load(open("pyproject.toml", "rb")).get("build-system", {}).get("requires", [])))' >/tmp/build-requires.txt \
  && if [ -s /tmp/build-requires.txt ]; then uv pip install --python .venv/bin/python --target /tmp/build-backend -r /tmp/build-requires.txt; fi \
  && rm -rf .venv /tmp/build-backend /tmp/build-requires.txt \
  && chmod -R a+rwX /var/cache/nightshift/uv

FROM debian:trixie@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5
# h5py is built against the system HDF5, so the libraries stay in the image and offline syncs reuse the cached build.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       libhdf5-dev build-essential pkg-config \
  && rm -rf /var/lib/apt/lists/*
ENV UV_NO_BINARY_PACKAGE=h5py
COPY --from=warm /var/cache/nightshift /var/cache/nightshift
COPY --from=warm-backend /var/cache/nightshift/uv /var/cache/nightshift/uv
