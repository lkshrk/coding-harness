from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
ROLES = ("explorer", "coder", "debugger", "escalation", "reviewer")


def _merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for key, value in override.items():
        out[key] = _merge(out[key], value) if isinstance(value, dict) and isinstance(out.get(key), dict) else value
    return out


@dataclass
class Experiment:
    name: str
    description: str
    harness: str
    models: dict[str, str]
    context: dict[str, int]
    steps: dict[str, int]
    policy: dict[str, int]
    raw: dict[str, Any] = field(repr=False)

    def model_context(self, model: str) -> int:
        return max(self.context[role] for role, m in self.models.items() if m == model)


@dataclass
class Task:
    id: str
    category: str
    toolchain: str
    repo: str
    base: str
    prompt: str
    verify: list[dict[str, str]]
    reference: str | None = None
    hidden_tests: list[str] = field(default_factory=list)


def load_experiment(path: str | Path) -> Experiment:
    path = Path(path)
    defaults = yaml.safe_load((path.parent / "_defaults.yaml").read_text())
    data = _merge(defaults, yaml.safe_load(path.read_text()))
    unknown = set(data["models"]) - set(ROLES)
    if unknown:
        raise ValueError(f"{path}: unknown roles {sorted(unknown)}")
    if "coder" not in data["models"]:
        raise ValueError(f"{path}: an experiment needs a coder model")
    return Experiment(
        name=data["name"],
        description=data.get("description", ""),
        harness=data["harness"],
        models=data["models"],
        context=data["context"],
        steps=data["steps"],
        policy=data["policy"],
        raw=data,
    )


def load_task(path: str | Path) -> Task:
    data = yaml.safe_load(Path(path).read_text())
    return Task(**data)


def benchmark_tasks(directory: str | Path = ROOT / "benchmark") -> list[Task]:
    return [load_task(p) for p in sorted(Path(directory).glob("*.yaml"))]
