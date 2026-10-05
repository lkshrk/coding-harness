# Environments

The environment layer of a repository's worker image, for repositories without their own `.devcontainer/`.

`ns env build <repo>` builds `nightshift/env-<repo>:<hash12>` with `devcontainer build`:

1. The workspace is `git archive <remote>/<base>` of the repository; the working tree is never read.
2. The environment layer is, in this order:
   - the repository's own `.devcontainer/` from that archive;
   - otherwise `environments/<repo>/` from this directory, copied to `.devcontainer/` (a missing
     `devcontainer.json` falls back to the default);
   - otherwise the default: `debian:trixie` with the `common-utils` Feature.
3. The detected stack Features (`features/stack-*`) and the agent layer (`features/agent-layer`) are
   copied into `.devcontainer/.nightshift/` and passed with `--additional-features`; the agent layer
   comes last.

The tag is the first 12 hex characters of the environment hash: marker and version files of the
selected stacks at `<remote>/<base>`, the version and content of each selected Feature and of the agent
layer, the environment definition (`.devcontainer/**` or the files here), and the archive files matched
by the globs in `customizations.nightshift.inputs` of its `devcontainer.json`. Image metadata is written
to `<paths.cache>/images/<repo>.json`; after a successful build only the current and previous tag of a
repository are kept.

An `environments/<repo>/` directory holds an ordinary dev container definition (`devcontainer.json`,
optionally a `Dockerfile`), nothing AI-specific.

## Warm steps

A definition can warm project dependencies at build time with a `Dockerfile` whose build context is the
archive (`"build": {"dockerfile": "Dockerfile", "context": ".."}`): a stage copies only the files it
needs from the archive, fills the caches the stack Features use (e.g. the pnpm store at
`/var/cache/nightshift/pnpm-store`), and the final stage copies the caches onto the base image. Every
archive file a warm step reads is listed in `customizations.nightshift.inputs`, so changing it rebuilds
the image while unrelated source changes do not.

`routivo/` warms the frontend: `pnpm install --frozen-lockfile --ignore-scripts` into the pnpm store,
and the inlang plugins of `frontend/project.inlang/settings.json` into
`/var/cache/nightshift/inlang/plugins/` under the file names of the inlang SDK's plugin cache. The SDK
falls back to `project.inlang/cache/plugins/` when the CDN is unreachable, so offline checks seed it:

```
pnpm install --offline --frozen-lockfile && mkdir -p project.inlang/cache && cp -R /var/cache/nightshift/inlang/plugins project.inlang/cache/
```

It also warms the backend: `uv sync --frozen` of `backend/pyproject.toml` and `backend/uv.lock` into the
uv cache at `/var/cache/nightshift/uv`, with h5py built from source against the image's
`libhdf5-dev` (`UV_NO_BINARY_PACKAGE=h5py` stays set in the image). The `stack-python` Feature brings
`uv`, the repository's Python, `ruff` and `ty`. The backend checks for `repositories.routivo.checks`:

```yaml
- name: backend-sync
  run: cd backend && uv sync --frozen --offline
- name: backend-lint
  run: cd backend && uv run --frozen --offline ruff check . && uv run --frozen --offline ruff format --check .
- name: backend-types
  run: cd backend && uv run --frozen --offline mypy app
- name: backend-test
  run: cd backend && uv run --frozen --offline pytest -q
```

## nightshift-vault

The closeout ingest's vault repository (`VAULT_REPOSITORY`, derived from `paths.vault`, also known to
`ns env build`) selects the `bun` stack explicitly, since the vault has no lockfile to detect. Its
`Dockerfile` installs `obsidian-wiki` with `uv tool install` into `/opt/nightshift/tools` (Python managed
by uv under the same prefix) and puts `/opt/nightshift/tools/bin` on `PATH`, so both lints run offline:

```
bun scripts/lint.ts && obsidian-wiki lint "$PWD"
```
