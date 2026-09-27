from __future__ import annotations

import json
import re
import shlex
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

import yaml

from .config import ROOT

DATASET = "princeton-nlp/SWE-bench_Verified"
ROWS_API = "https://datasets-server.huggingface.co/rows"
# Repos whose SWE-bench environments are plain pip installs with a file-based test command.
SUPPORTED = (
    "psf/requests",
    "pallets/flask",
    "pytest-dev/pytest",
    "pylint-dev/pylint",
    "sympy/sympy",
    "mwaskom/seaborn",
    "pydata/xarray",
)
VENV = "/home/agent/venv"
TASK_ENV = {
    "VIRTUAL_ENV": VENV,
    "PATH": f"{VENV}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
}


class _BlockDumper(yaml.SafeDumper):
    pass


def _str(dumper: yaml.SafeDumper, value: str) -> yaml.ScalarNode:
    style = "|" if "\n" in value else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", value, style=style)


_BlockDumper.add_representer(str, _str)


def fetch_rows() -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        query = urllib.parse.urlencode(
            {"dataset": DATASET, "config": "default", "split": "test", "offset": offset, "length": 100}
        )
        with urllib.request.urlopen(f"{ROWS_API}?{query}", timeout=120) as response:
            page = json.load(response)
        rows += [r["row"] for r in page["rows"]]
        offset += 100
        if offset >= page["num_rows_total"]:
            return rows


def _specs() -> dict:
    try:
        from swebench.harness.constants import MAP_REPO_VERSION_TO_SPECS
    except ImportError as exc:  # swebench>=5 dropped the per-repo spec table
        raise SystemExit("needs the swebench extra: uv run --extra swebench harness import-swebench") from exc
    return MAP_REPO_VERSION_TO_SPECS


def _requirements(row: dict) -> str:
    """SWE-bench installs its repo-specific requirements file as of the environment setup commit."""
    from swebench.harness.test_spec.python import get_requirements

    return get_requirements(row)


def _setup(spec: dict, row: dict) -> list[str] | None:
    """Environment setup as sandbox commands, or None when the spec needs more than pip."""
    if spec.get("pre_install") or spec.get("eval_commands"):
        return None
    packages = spec.get("packages", "")
    if packages and packages not in ("requirements.txt",) and ".yml" in packages:
        return None
    steps = [f"uv venv -q --seed --python {spec['python']} {VENV}"]
    if packages == "requirements.txt":
        reqs = _requirements(row).strip()
        steps.append(
            f"cat > /home/agent/requirements.txt <<'REQS'\n{reqs}\nREQS\n"
            "python -m pip install -q -r /home/agent/requirements.txt"
        )
    elif packages:
        steps.append(f"python -m pip install -q {packages}")
    if spec.get("pip_packages"):
        steps.append("python -m pip install -q " + " ".join(shlex.quote(p) for p in spec["pip_packages"]))
    steps.append(spec["install"].replace("python -m pip install", "python -m pip install -q", 1))
    return steps


def to_task(row: dict, spec: dict) -> dict | None:
    setup = _setup(spec, row)
    if setup is None:
        return None
    test_files = sorted(set(re.findall(r"^diff --git a/(\S+) b/", row["test_patch"], re.MULTILINE)))
    fail_to_pass, pass_to_pass = json.loads(row["FAIL_TO_PASS"]), json.loads(row["PASS_TO_PASS"])
    if spec["test_cmd"].startswith("pytest"):
        # Same selection as the SWE-bench harness: only listed tests, so unrelated/network tests don't decide.
        visible = pass_to_pass or [f"--collect-only -q {' '.join(test_files)}"]
        verify = [{"name": "tests", "run": f"{spec['test_cmd']} {' '.join(shlex.quote(t) for t in visible)}"}]
        hidden = [
            {
                "name": "tests",
                "run": f"{spec['test_cmd']} " + " ".join(shlex.quote(t) for t in fail_to_pass + pass_to_pass),
            }
        ]
    else:
        verify = hidden = [{"name": "tests", "run": f"{spec['test_cmd']} {' '.join(test_files)}"}]
    return {
        "id": "swe-" + row["instance_id"].replace("__", "-").lower(),
        "category": f"swe-bench:{row['difficulty']}",
        "source": f"{DATASET}:{row['instance_id']}",
        "toolchain": "python",
        "repo": f"https://github.com/{row['repo']}",
        "base": row["base_commit"],
        "prompt": row["problem_statement"].strip() + "\n",
        "env": TASK_ENV,
        "setup": setup,
        "verify": verify,
        "hidden_verify": hidden,
        "reference_patch": row["patch"],
        "hidden_test_patch": row["test_patch"],
    }


def import_tasks(repos: list[str], difficulties: list[str], per_repo: int, limit: int) -> list[Path]:
    specs = _specs()
    by_repo: dict[str, list[dict]] = defaultdict(list)
    for row in sorted(fetch_rows(), key=lambda r: r["instance_id"]):
        if row["repo"] in repos and row["difficulty"] in difficulties:
            by_repo[row["repo"]].append(row)

    written: list[Path] = []
    for repo in repos:
        taken = 0
        for row in by_repo[repo]:
            if taken >= per_repo or len(written) >= limit:
                break
            task = to_task(row, specs[repo][row["version"]])
            if task is None:
                continue
            path = ROOT / "benchmark" / f"{task['id']}.yaml"
            path.write_text(
                yaml.dump(task, Dumper=_BlockDumper, sort_keys=False, width=110, allow_unicode=True)
            )
            written.append(path)
            taken += 1
    return written
