from __future__ import annotations

import os

from phoenix.client import Client

from .config import ROOT, Experiment, benchmark_tasks, load_task
from .runner import run_task

EXPERIMENT_TIMEOUT_S = 4 * 3600


def client() -> Client:
    return Client(base_url=os.environ["PHOENIX_BASE_URL"], api_key=os.environ.get("PHOENIX_API_KEY") or None)


def sync_dataset(name: str) -> None:
    examples = [
        {
            "input": {"task_id": t.id, "prompt": t.prompt},
            "output": {"reference": t.reference},
            "metadata": {"category": t.category, "repo": t.repo, "base": t.base, "toolchain": t.toolchain},
        }
        for t in benchmark_tasks()
    ]
    client().datasets.create_dataset(name=name, examples=examples)
    print(f"dataset {name}: {len(examples)} tasks")


def _task(input: dict) -> dict:
    task = load_task(ROOT / "benchmark" / f"{input['task_id']}.yaml")
    result = run_task(task, _task.experiment)  # type: ignore[attr-defined]
    return {k: v for k, v in result.items() if k not in ("steps", "verifications")}


def success(output: dict) -> bool:
    return output["outcome"] == "success"


def checks_passed(output: dict) -> bool:
    return bool(output["checks_passed"])


def review_agrees(output: dict) -> float | None:
    return None if output["review_agrees"] is None else float(output["review_agrees"])


def frontier_used(output: dict) -> bool:
    return bool(output["frontier_used"])


def escalations(output: dict) -> int:
    return len(output["escalations"])


def cost_usd(output: dict) -> float | None:
    return output["cost_usd"]


def run_experiment(experiment: Experiment, dataset: str) -> None:
    c = client()
    ds = c.datasets.get_dataset(dataset=dataset)
    _task.experiment = experiment  # type: ignore[attr-defined]
    c.experiments.run_experiment(
        dataset=ds,
        task=_task,
        evaluators=[success, checks_passed, review_agrees, frontier_used, escalations, cost_usd],
        experiment_name=experiment.name,
        experiment_description=experiment.description,
        experiment_metadata={
            "harness": experiment.harness,
            **{f"model.{k}": v for k, v in experiment.models.items()},
            "policy": experiment.policy,
            "context": experiment.context,
        },
        timeout=EXPERIMENT_TIMEOUT_S,
        retries=0,
    )
