from __future__ import annotations

import os
import shlex
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.base import NonZeroAgentExitCodeError, with_prompt_template
from harbor.agents.installed.opencode import OpenCode, OpenCodeOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from pydantic import Field

# OpenCode v2 is not published to npm, so Harbor's stock adapter would install v1.
RELEASES: dict[str, tuple[str, str]] = {
    "x86_64": (
        "https://opencode.ai/files/bin/2.0.22/opencode-linux-x64-baseline.tar.gz",
        "6414bc6a441ef28bc549984baf2f60fb95e8fe46713bd17293921400ddfe6d33",
    ),
    "aarch64": (
        "https://opencode.ai/files/bin/2.0.22/opencode-linux-arm64.tar.gz",
        "3f4df7efe28a53830777666e160984cf8247938e68f105b8ae1f9b4778febc2d",
    ),
}
CA_PATH = "/usr/local/share/ca-certificates/nightshift-lan.crt"
PASSTHROUGH = ("LITELLM_API_KEY",)


def container_env(base: dict[str, str], host: dict[str, str], ca: bool) -> dict[str, str]:
    env = dict(base)
    env["OPENCODE_FAKE_VCS"] = "git"
    env["XDG_DATA_HOME"] = "/logs/agent/opencode/xdg-data"
    env["XDG_STATE_HOME"] = "/logs/agent/opencode/xdg-state"
    if ca:
        env["NODE_EXTRA_CA_CERTS"] = CA_PATH
    env.update({k: host[k] for k in PASSTHROUGH if k in host})
    return env


def install_command() -> str:
    cases = " ".join(f"{arch}) url={shlex.quote(url)}; sha={sha};;" for arch, (url, sha) in RELEASES.items())
    return (
        "set -euo pipefail; "
        f'case "$(uname -m)" in {cases} *) echo "unsupported arch $(uname -m)" >&2; exit 1;; esac; '
        'tmp="$(mktemp -d)"; '
        'curl -fsSL -o "$tmp/oc.tgz" "$url"; '
        'echo "$sha  $tmp/oc.tgz" | sha256sum -c -; '
        'tar -xzf "$tmp/oc.tgz" -C "$tmp"; '
        'install -m 755 "$tmp/opencode" /usr/local/bin/opencode; '
        'rm -rf "$tmp"; opencode --version'
    )


def trust_ca_command(pem: str, path: str = CA_PATH, refresh: str = "update-ca-certificates") -> str:
    return (
        f"mkdir -p {shlex.quote(str(Path(path).parent))} && "
        f"printf %s {shlex.quote(pem)} > {shlex.quote(path)} && {refresh}"
    )


def run_command(model: str, instruction: str, flags: str = "") -> str:
    if "/" not in model:
        raise ValueError("Model name must be in the format provider/model_name")
    return (
        f"opencode run --model={shlex.quote(model)} --standalone --format=json --thinking "
        f"{flags}-- {shlex.quote(instruction)} 2>&1 </dev/null | stdbuf -oL tee /logs/agent/opencode.txt"
    )


class OpenCodeV2Options(OpenCodeOptions):
    ca_bundle: str | None = Field(
        default=None, description="Host path of a PEM CA to trust in the task container."
    )


class OpenCodeV2(OpenCode):
    options_model = OpenCodeV2Options
    _DEFAULT_CONFIG: dict[str, Any] = {"permission": {"*": "allow"}}

    def __init__(self, *args: Any, ca_bundle: str | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._ca_pem = Path(ca_bundle).expanduser().read_text() if ca_bundle else None

    @staticmethod
    @override
    def name() -> str:
        return "opencode-v2"

    @override
    def get_version_command(self) -> str | None:
        return "opencode --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl", "bash", "coreutils", "tar"))
        await self.exec_as_root(environment, command=install_command())
        if self._ca_pem:
            await self.exec_as_root(environment, command=trust_ca_command(self._ca_pem))

    @override
    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        self._instruction = instruction
        # Secrets come from the host process env per exec, so they never land in the saved job config.
        env = container_env(dict(self.model_connection.env), dict(os.environ), self._ca_pem is not None)

        for command in (self._build_register_skills_command(), self._build_register_config_command()):
            if command:
                await self.exec_as_agent(environment, command=command, env=env)

        flags = self.build_cli_flags()
        flags = f"{flags} " if flags else ""
        await self.exec_as_agent(
            environment, command=run_command(self.model_name or "", instruction, flags), env=env
        )

        if messages := self._error_messages():
            raise NonZeroAgentExitCodeError("OpenCode emitted error event(s): " + "; ".join(messages[:3]))
