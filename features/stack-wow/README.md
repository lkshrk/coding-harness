# WoW worker stack (N1)

Detects `*.toc` files containing a line starting with `## Interface`, including
nested addons. Targets retail WoW 12.1 (`WOW_INTERFACE=120100`). The worker gets
Lua 5.1 (`lua` and `lua5.1`), luacheck, LuaLS with WoW annotations, `wow-api`,
and `wow-check`. No runtime downloads or network allowlist are needed.

Installation needs network access and Debian trixie on linux/amd64 or linux/arm64.
Sources, generated luacheck configuration, and warmed API/FrameXML indexes live
under `/var/cache/nightshift/wow`. Source checkouts have their `.git` removed so
partial-clone fetches cannot happen at runtime. Workers read the baked cache;
temporary diagnostic files and LuaLS logs go under `/tmp`.

## Pins

LuaLS is pinned in `mise.toml` and `mise.lock` (linux-x64 and linux-arm64) and
installed by the shared mise Feature's `nightshift-mise-install`. After changing
`mise.toml`, run `mise lock --platform linux-x64,linux-arm64` in this directory.
`tools.sh` holds the remaining pins and is also installed as `$WOW_HOME/pins.sh`:

| Component | Pin |
| --- | --- |
| Lua (Debian) | `5.1.5-11` |
| luacheck (Debian) | `1.2.0-1` |
| Ketho/vscode-wow-api | `d0b5b51fac4c52c493371b9b18e66ce604ea4326` |
| Gethe/wow-ui-source | `09b9db7948abc9b9648dedaab51eb0cf3ee67b31` |
| Ketho/BlizzardInterfaceResources | `36dd01db2d8fa5086dffda5cbfb3d55f4a70e526` |

## Commands

```sh
wow-api C_PetJournal.GetPetInfoTableByPetID
wow-api PET_JOURNAL_LIST_UPDATE --kind event
wow-api GetPetInfo --json
wow-check BattleBuddy
wow-check --fast BattleBuddy # skip LuaLS
wow-check --no-lua BattleBuddy # TOC/XML only
```

`wow-check` combines TOC/XML reference validation, luacheck with FrameXML and
repository globals, and LuaLS diagnostics. A repository `.luacheckrc` wins over
the generated configuration; an addon `.luarc.json` wins over the LuaLS defaults.
Errors produce exit 1; warnings alone do not fail. Missing `Libs/` references are
reported as notes because addon packagers commonly provide them. This is static
validation, not a WoW client emulator or proof of in-game behavior.

## Validation

Local checks (no image build):

```sh
~/.bun/bin/bun test packages/core/src/stacks features/stack-wow
~/.bun/bin/bun x biome check --write features/stack-wow packages/core/src/stacks/load.test.ts packages/core/src/stacks/detect.test.ts packages/core/src/stacks/build.test.ts
shellcheck -x features/stack-wow/{install,test,tools}.sh
bash -n features/stack-wow/install.sh
bash -n features/stack-wow/test.sh
bash -n features/stack-wow/tools.sh
```

The Bun helper suite executes Python directly with local fixtures. It covers API
lookup, read-only warmed caches, FrameXML globals, missing TOC/XML files, malformed
tables, luacheck argument separation, missing tools, failed processes, and timeout
handling. Stack tests cover loading the real feature, TOC detection, mocked build
composition, and image-hash invalidation on pin/installer/helper changes.

Local results, 2026-10-05:

```text
bun test v1.4.2 (744846f84)
86 pass
0 fail
174 expect() calls
Ran 86 tests across 4 files. [1391.00ms]

biome check --write: Checked 5 files in 48ms. No fixes applied.
shellcheck -x: exit 0 (install.sh, test.sh, tools.sh)
bash -n: exit 0 for each of install.sh, test.sh, tools.sh
Smoke embedded Python: syntax PASS
Real local luacheck: globals discovery, valid addon, undefined-global diagnostics PASS
```

The initial run hit machine-global Git hooks/signing in the temporary `gitTree`
fixture; fixture-local configuration now isolates both. The luacheck argument
regression was observed failing before the fix. No image was built or executed.
Repo-wide `bun run check` was not rerun; the user-reported fenced-input-block
failure belongs to XXX-250 and remains outside this task.

Run the following **later**, on a Docker host, for each architecture:

```sh
PLATFORM=linux/amd64 features/test/build.sh nightshift-wow:amd64 stack-wow
docker run --rm --network=none --read-only --user 65534:65534 \
  --tmpfs /tmp:rw,exec,mode=1777 \
  -v "$PWD/features/stack-wow/test.sh:/test.sh:ro" \
  nightshift-wow:amd64 bash /test.sh
# Repeat with PLATFORM=linux/arm64 and nightshift-wow:arm64.
```

`test.sh` checks baked caches, Lua 5.1 semantics, direct luacheck, LSP initialize
and orderly shutdown, full `wow-check`, Lua test execution, API/event lookup,
missing API rejection, and missing-file/undefined-global diagnostics.
Network isolation is enforced by the container invocation, not by the script.

Image validation, 2026-10-05: `linux/amd64` built on towerr-dev in about 30s
(`nightshift-wow:amd64`, 183 MB) and the offline smoke above passes as
`nobody` with `--network=none --read-only`. `wow-check BattleBuddy` reports
0 errors and 0 warnings in the image. `linux/arm64` has not been built.
The first smoke run exposed that LuaLS stays alive after `shutdown` + `exit`
until its stdin closes; `test.sh` now closes stdin after `exit`.

## BattleBuddy configuration (reference only)

Read-only inspection of `~/Dev/wow-battle-buddy/tests/*_test.lua` confirmed that
the scripts consume their first vararg as the source root. Run from the repository
root and pass `.` explicitly: `workflow_state_test.lua` otherwise defaults to `..`.
This block has not been written to any live configuration:

```yaml
repositories:
  wow-battle-buddy:
    path: ~/Dev/wow-battle-buddy
    remote: origin
    base: main
    stacks: auto
    checks:
      - name: wow-check
        run: wow-check BattleBuddy
        timeout: 30m
      - name: lua-tests
        run: 'for t in tests/*_test.lua; do lua5.1 "$t" . || exit 1; done'
        timeout: 5m
    risk_paths: []
    macos_only: false
```

## Local completion files

- `features/stack-wow/stack.yaml`, `devcontainer-feature.json`, `install.sh`, and
  `tools.sh`: existing feature definition and pinned installer, retained.
- `features/stack-wow/test.sh`: completed offline image smoke and LSP lifecycle.
- `features/stack-wow/wow-tools.py`: fixed luacheck global discovery: `--` separates
  files from the variadic `--only` warning filters, preventing cache warmup failure.
- `features/stack-wow/wow-tools.test.ts`: regression and read-only cache coverage;
  suppress Python bytecode writes so tests do not alter feature hashes.
- `packages/core/src/stacks/{load,detect,build}.test.ts`: real feature metadata,
  multiple-TOC detection, content-hash coverage, isolated fixture Git hooks/signing.
- `.agent-progress.md`: bounded subagent progress and final verification record.

No commits, pushes, deployments, remote sync, Linear writes, live config edits,
or BattleBuddy modifications are part of this completion.
