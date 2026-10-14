# renovate: datasource=docker depName=ghcr.io/astral-sh/uv
FROM ghcr.io/astral-sh/uv:0.13.1@sha256:4a1f3666816dafadd20ceb71eac9a7d56d7ef30279f7d64048519ab901ada336 AS uv

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
# PGDG, because trixie ships only PostgreSQL 17 and Routivo's CI runs 18.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt trixie-pgdg main' >/etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql-18 \
  && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 .devcontainer/with-postgres.sh /usr/local/bin/with-postgres
# Same DuckDB as Routivo's mise.toml and CI image; osm_build/build.sh reads spatial from DUCKDB_EXTENSION_DIRECTORY.
ARG DUCKDB_VERSION=1.5.6
ARG DUCKDB_SHA256_AMD64=6e89deac1ebbc36eed0291caf8b567b030c7b86ac35998f71854e22b3c5d5e2f
ARG DUCKDB_SHA256_ARM64=c544e92c9b7c31fc53c2139802cabd8e2d1b2b3e3f933117f31611239c1402db
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends osmium-tool unzip \
  && rm -rf /var/lib/apt/lists/* \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
       amd64) sha="$DUCKDB_SHA256_AMD64" ;; \
       arm64) sha="$DUCKDB_SHA256_ARM64" ;; \
       *) echo "unsupported architecture $arch" >&2; exit 1 ;; \
     esac \
  && curl -fsSL -o /tmp/duckdb.zip "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb_cli-linux-${arch}.zip" \
  && echo "${sha}  /tmp/duckdb.zip" | sha256sum -c - \
  && unzip -q /tmp/duckdb.zip -d /usr/local/bin \
  && rm /tmp/duckdb.zip \
  && duckdb -c "SET extension_directory='/opt/duckdb/extensions'; INSTALL spatial;" \
  && chmod -R a+rX /opt/duckdb
ENV DUCKDB_EXTENSION_DIRECTORY=/opt/duckdb/extensions
COPY --from=warm /var/cache/nightshift /var/cache/nightshift
COPY --from=warm-backend /var/cache/nightshift/uv /var/cache/nightshift/uv
