# renovate: datasource=docker depName=ghcr.io/astral-sh/uv
FROM ghcr.io/astral-sh/uv:python3.14-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git ca-certificates curl xz-utils libhdf5-dev build-essential pkg-config \
  && rm -rf /var/lib/apt/lists/*

# renovate: datasource=node-version depName=node versioning=node
ARG NODE_VERSION=24.21.0
RUN arch="$(dpkg --print-architecture)"; case "$arch" in amd64) n=x64;; arm64) n=arm64;; *) exit 1;; esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${n}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
  && corepack enable

ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=0 PNPM_HOME=/root/.local/share/pnpm CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN git config --global user.email env@nightshift.local && git config --global user.name nightshift
WORKDIR /work/repo
