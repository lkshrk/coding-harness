# renovate: datasource=docker depName=ghcr.io/astral-sh/uv
FROM ghcr.io/astral-sh/uv:0.12.23@sha256:61d393e44e249f2e4b526b6c7ddcecce245946826e608e11c93ad4f5bba55b21 AS uv

FROM debian:trixie@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5 AS tools

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

FROM debian:trixie@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5
COPY --from=tools /opt/nightshift/tools /opt/nightshift/tools
ENV PATH=/opt/nightshift/tools/bin:$PATH
