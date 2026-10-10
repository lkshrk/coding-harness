# renovate: datasource=docker depName=ghcr.io/astral-sh/uv
FROM ghcr.io/astral-sh/uv:0.13.0@sha256:cdc6093146eb3ff6a40107b38f008b789e050e77ad87865e381d9917da55a168 AS uv

FROM debian:trixie@sha256:9cc080028c43b27d2074d63a5f9caf7166d731494965616c1a6d2827a004585c AS tools

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /usr/local/bin/uv

# renovate: datasource=python-version depName=python
ARG PYTHON_VERSION=3.14.8
# renovate: datasource=pypi depName=obsidian-wiki
ARG OBSIDIAN_WIKI_VERSION=2026.10.1

ENV UV_PYTHON_INSTALL_DIR=/opt/nightshift/tools/python \
    UV_TOOL_DIR=/opt/nightshift/tools/venvs \
    UV_TOOL_BIN_DIR=/opt/nightshift/tools/bin \
    UV_PYTHON_PREFERENCE=only-managed \
    UV_CACHE_DIR=/tmp/uv-cache \
    UV_LINK_MODE=copy

RUN uv tool install --python "$PYTHON_VERSION" "obsidian-wiki==$OBSIDIAN_WIKI_VERSION" \
  && /opt/nightshift/tools/bin/obsidian-wiki --version \
  && rm -rf /tmp/uv-cache \
  && chmod -R a+rX /opt/nightshift/tools

FROM debian:trixie@sha256:9cc080028c43b27d2074d63a5f9caf7166d731494965616c1a6d2827a004585c
COPY --from=tools /opt/nightshift/tools /opt/nightshift/tools
ENV PATH=/opt/nightshift/tools/bin:$PATH
