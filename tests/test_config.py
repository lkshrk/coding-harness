from pathlib import Path

import pytest

from coding_harness.cli import check_config
from coding_harness.config import ROOT, load_experiment, load_task


def test_all_experiments_and_tasks_load():
    assert check_config()


def test_defaults_merge_and_override():
    exp = load_experiment(ROOT / "experiments" / "F-hierarchy-frontier.yaml")
    assert exp.policy["escalation_attempts"] == 1
    assert exp.policy["coder_retries"] == 2
    assert exp.prompts == "custom"


def test_model_context_takes_largest_role_budget():
    exp = load_experiment(ROOT / "experiments" / "E-qwen-only.yaml")
    assert exp.model_context("basic/qwen3-coder-next") == max(exp.context[r] for r in exp.models)


def _write(tmp_path: Path, body: str) -> Path:
    (tmp_path / "_defaults.yaml").write_text((ROOT / "experiments" / "_defaults.yaml").read_text())
    path = tmp_path / "x.yaml"
    path.write_text(body)
    return path


def test_unknown_role_rejected(tmp_path):
    with pytest.raises(ValueError, match="unknown roles"):
        load_experiment(_write(tmp_path, "name: x\nmodels:\n  coder: m\n  planner: m\n"))


def test_coder_required(tmp_path):
    with pytest.raises(ValueError, match="coder"):
        load_experiment(_write(tmp_path, "name: x\nmodels:\n  reviewer: m\n"))


def test_unknown_prompt_set_rejected(tmp_path):
    with pytest.raises(ValueError, match="prompts"):
        load_experiment(_write(tmp_path, "name: x\nprompts: fancy\nmodels:\n  coder: m\n"))


def test_swebench_task_fields():
    task = load_task(next((ROOT / "benchmark").glob("swe-*.yaml")))
    assert task.reference_patch and task.hidden_test_patch and task.setup and task.hidden_verify
