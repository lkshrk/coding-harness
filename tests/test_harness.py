import json

import pytest

from coding_harness.config import ROOT, load_experiment, load_task
from coding_harness.harness import VENDOR_PROMPT, DeepSeekHarness, OpenCode, StepResult, _classify
from coding_harness.sandbox import Sandbox


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("LITELLM_BASE_URL", "https://gateway.example/v1")
    monkeypatch.setenv("LITELLM_API_KEY", "sk-test")


def _setup(tmp_path, experiment):
    task = load_task(ROOT / "benchmark" / "tuppr-single-node-drain.yaml")
    harness = OpenCode(Sandbox(tmp_path, task), load_experiment(ROOT / "experiments" / experiment), "run-1")
    harness.setup()
    return tmp_path / "home" / ".config" / "opencode"


def test_opencode_renders_provider_and_agents(tmp_path):
    conf = _setup(tmp_path, "F-hierarchy-frontier.yaml")
    config = json.loads((conf / "opencode.json").read_text())
    provider = config["provider"]["litellm"]
    assert provider["options"]["headers"] == {"x-litellm-end-user-id": "{env:RUN_ID}"}
    assert provider["models"]["basic/glm-5.3-flash"]["limit"]["context"] == 32768
    escalation = (conf / "agents" / "escalation.md").read_text()
    assert escalation.startswith("---\nmodel: litellm/frontier-code\nsteps: 60\n")


def test_vendor_prompt_set_keeps_opencode_prompt(tmp_path):
    coder = (_setup(tmp_path, "B-qwen-coder-vendor.yaml") / "agents" / "coder.md").read_text()
    body = coder.split("---\n", 2)[2]
    assert body.startswith(VENDOR_PROMPT.read_text()[:200])
    assert "# Your role in this run" in body


def test_custom_prompt_set_replaces_it(tmp_path):
    coder = (_setup(tmp_path, "B-qwen-coder.yaml") / "agents" / "coder.md").read_text()
    assert "You are opencode" not in coder


def test_dsh_profile_renders(tmp_path, env):
    task = load_task(ROOT / "benchmark" / "tuppr-single-node-drain.yaml")
    harness = DeepSeekHarness(
        Sandbox(tmp_path, task), load_experiment(ROOT / "experiments" / "B-qwen-coder-dsh.yaml"), "run-1"
    )
    from string import Template

    from coding_harness.harness import DSH_TEMPLATE

    profile = Template(DSH_TEMPLATE.read_text()).substitute(
        base_url="https://gateway.example/v1", run_id="run-1", model="m", context=65536
    )
    assert "enabled: false" in profile and "x-litellm-end-user-id: run-1" in profile
    assert harness.name == "dsh"


@pytest.mark.parametrize(
    ("error", "exit_code", "tools", "expected"),
    [
        ("HTTP 429 rate limit exceeded", 1, 0, "infra"),
        ("upstream 503 Service Unavailable", 1, 0, "infra"),
        ("tool schema mismatch", 1, 3, "model"),
        ("", 0, 0, "model"),
        ("", 0, 4, None),
    ],
)
def test_classify(error, exit_code, tools, expected):
    step = StepResult("coder", "m", "opencode", exit_code, 1.0, tool_calls=tools, error=error)
    _classify(step)
    assert step.failure == expected
    if expected:
        assert step.error
