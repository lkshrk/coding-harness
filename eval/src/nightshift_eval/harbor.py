from __future__ import annotations

import json
import subprocess
from pathlib import Path

from nightshift_eval.mine import Patches, PullRequest
from nightshift_eval.repo_rules import RepoRules

WORKDIR = "/work/repo"


def _toml_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return str(value)
    if isinstance(value, list | tuple):
        return "[" + ", ".join(_toml_value(v) for v in value) + "]"
    return json.dumps(str(value), ensure_ascii=False)


def _table(name: str, values: dict[str, object]) -> str:
    lines = [f"[{name}]"] + [f"{k} = {_toml_value(v)}" for k, v in values.items()]
    return "\n".join(lines) + "\n"


def _write(path: Path, content: str, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    if executable:
        path.chmod(0o755)


def _instruction(pr: PullRequest) -> str:
    refs = ", ".join(pr.linear_refs) or "none"
    return (
        "<!-- nightshift: raw statement from the PR title; rewritten from the linked issue in V1b -->\n"
        f"# {pr.title}\n\n"
        f"Linked issues: {refs}\n"
    )


def _test_script(patches: Patches, rules: RepoRules) -> str:
    commands = [
        rules.test_command(part, [f for f in patches.test_files if rules.classify(f)[1] == part])
        for part in patches.parts
    ]
    run = " && ".join(f"( {c} )" for c in commands)
    return (
        "#!/bin/bash\n"
        "set -u\n"
        "mkdir -p /logs/verifier\n"
        f"cd {WORKDIR}\n"
        "if ! git apply /tests/test.patch; then echo 0 > /logs/verifier/reward.txt; exit 0; fi\n"
        f"if {run}; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi\n"
    )


def _dockerfile(patches: Patches, rules: RepoRules) -> str:
    lines = [
        f"FROM {rules.base_image}",
        "COPY repo.tar /tmp/repo.tar",
        f"RUN tar -xf /tmp/repo.tar -C {WORKDIR} && rm /tmp/repo.tar"
        " && git init -q && git add -A && git commit -qm base",
    ]
    for part in patches.parts:
        p = rules.part(part)
        lines.append(f"RUN --mount=type=cache,target={p.cache} {p.setup}")
    return "\n".join(lines) + "\n"


def emit_task(
    out_root: Path,
    pr: PullRequest,
    patches: Patches,
    rules: RepoRules,
    repo_url: str,
    repo_path: Path,
) -> Path:
    task_id = f"{rules.name}-pr-{pr.number}"
    out = out_root / task_id
    toml = "\n".join(
        [
            'schema_version = "1.1"\n',
            _table(
                "task",
                {
                    "name": f"nightshift/{task_id}",
                    "description": pr.title,
                    "keywords": [rules.name, *patches.parts],
                },
            ),
            _table(
                "metadata.nightshift",
                {
                    "repo": repo_url,
                    "pr": pr.number,
                    "base": patches.base,
                    "merge": patches.merge,
                    "parts": list(patches.parts),
                    "source_files": list(patches.source_files),
                    "test_files": list(patches.test_files),
                    "changed_lines": pr.changed_lines,
                    "linear_refs": list(pr.linear_refs),
                    "needs_rewrite": True,
                },
            ),
            _table("agent", {"timeout_sec": 2700.0}),
            _table("verifier", {"timeout_sec": 900.0}),
            _table("environment", {"build_timeout_sec": 1800.0, "cpus": 4, "memory_mb": 8192}),
        ]
    )
    _write(out / "task.toml", toml)
    _write(out / "instruction.md", _instruction(pr))
    _write(out / "environment/Dockerfile", _dockerfile(patches, rules))
    (out / "environment/repo.tar").write_bytes(
        subprocess.run(
            ["git", "-C", str(repo_path), "archive", "--format=tar", patches.base],
            check=True,
            capture_output=True,
        ).stdout
    )
    _write(out / "solution/gold.patch", patches.gold_patch)
    _write(
        out / "solution/solve.sh",
        f"#!/bin/bash\nset -euo pipefail\ncd {WORKDIR}\ngit apply /solution/gold.patch\n",
        True,
    )
    _write(out / "tests/test.patch", patches.test_patch)
    _write(out / "tests/test.sh", _test_script(patches, rules), True)
    return out
