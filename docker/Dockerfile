# Sandbox image: task toolchain + both harnesses. BASE selects the toolchain (see justfile).
ARG BASE=python:3.13-bookworm
FROM ${BASE}

ARG NODE_MAJOR=24
ARG OPENCODE_VERSION=1.18.32
ARG DSH_VERSION=0.1.7-rc.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep jq \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" "@deepseek-ai/dsh@${DSH_VERSION}" \
    && npm cache clean --force

COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /uvx /usr/local/bin/

ENV OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_MODELS_FETCH=1 \
    OPENCODE_DISABLE_LSP_DOWNLOAD=1 \
    DSH_TELEMETRY_DISABLED=1 \
    DSH_TELEMETRY_MODE=DISABLED \
    DSH_PERMISSION_MODE=danger-full-access \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=/work \
    HOME=/home/agent

WORKDIR /work
