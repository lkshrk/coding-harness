from __future__ import annotations

import io
import json
import os
import re
from dataclasses import asdict, dataclass, field
from string import Template

import zstandard

from .config import ROOT, Experiment
from .sandbox import HOME, Sandbox

AGENTS_DIR = ROOT / "harnesses" / "opencode" / "agents"
DSH_TEMPLATE = ROOT / "harnesses" / "dsh" / "profile.tmpl.yml"
INFRA_ERROR = re.compile(
    r"\b(429|50[0-4])\b|rate.?limit|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|overloaded|"
    r"service unavailable|connection error|socket hang up",
    re.IGNORECASE,
)


def role_prompt_file(role: str) -> str:
    return "coder" if role == "escalation" else role


@dataclass
class StepResult:
    role: str
    model: str
    harness: str
    exit_code: int
    duration_s: float
    text: str = ""
    tool_calls: int = 0
    steps: int = 0
    tokens: dict[str, int] = field(default_factory=dict)
    cost: float | None = None
    error: str = ""
    failure: str | None = None  # None | "infra" | "model"

    def record(self) -> dict:
        data = asdict(self)
        data["text"] = self.text[-2000:]
        data["error"] = self.error[-2000:]
        return data


def _env(run_id: str) -> dict[str, str]:
    return {
        "LITELLM_BASE_URL": os.environ["LITELLM_BASE_URL"],
        "LITELLM_API_KEY": os.environ["LITELLM_API_KEY"],
        "RUN_ID": run_id,
    }


def _save_raw(sandbox: Sandbox, role: str, stdout: str, stderr: str) -> None:
    raw = sandbox.run_dir / "raw"
    raw.mkdir(exist_ok=True)
    n = len(list(raw.glob("*.ndjson"))) + 1
    (raw / f"{n:02d}-{role}.ndjson").write_text(stdout)
    if stderr:
        (raw / f"{n:02d}-{role}.stderr").write_text(stderr)


def _classify(step: StepResult) -> None:
    if step.exit_code == 0 and not step.error:
        if step.tool_calls == 0 and step.role in ("coder", "debugger", "escalation"):
            step.failure, step.error = "model", "finished without a single tool call"
        return
    step.failure = "infra" if INFRA_ERROR.search(step.error) else "model"
    if not step.error.strip():
        step.error = f"exit {step.exit_code} without error output"


def _add_tokens(total: dict[str, int], tokens: dict) -> None:
    for key, value in tokens.items():
        if isinstance(value, dict):
            for sub, v in value.items():
                if isinstance(v, (int, float)):
                    total[f"{key}_{sub}"] = total.get(f"{key}_{sub}", 0) + int(v)
        elif isinstance(value, (int, float)):
            total[key] = total.get(key, 0) + int(value)


class OpenCode:
    name = "opencode"

    def __init__(self, sandbox: Sandbox, experiment: Experiment, run_id: str):
        self.sandbox, self.experiment, self.run_id = sandbox, experiment, run_id

    def setup(self) -> None:
        conf_dir = self.sandbox.home / ".config" / "opencode"
        (conf_dir / "agents").mkdir(parents=True, exist_ok=True)
        models = sorted(set(self.experiment.models.values()))
        config = {
            "$schema": "https://opencode.ai/config.json",
            "autoupdate": False,
            "share": "disabled",
            "permission": "allow",
            "compaction": {"auto": True, "prune": True},
            "model": f"litellm/{self.experiment.models['coder']}",
            "provider": {
                "litellm": {
                    "npm": "@ai-sdk/openai-compatible",
                    "name": "LiteLLM",
                    "options": {
                        "baseURL": "{env:LITELLM_BASE_URL}",
                        "apiKey": "{env:LITELLM_API_KEY}",
                        "headers": {"x-litellm-end-user-id": "{env:RUN_ID}"},
                        "timeout": 600000,
                    },
                    "models": {
                        m: {"name": m, "limit": {"context": self.experiment.model_context(m), "output": 16384}}
                        for m in models
                    },
                }
            },
        }
        (conf_dir / "opencode.json").write_text(json.dumps(config, indent=2))
        for role, model in self.experiment.models.items():
            body = (AGENTS_DIR / f"{role_prompt_file(role)}.md").read_text()
            header = f"---\nmodel: litellm/{model}\nsteps: {self.experiment.steps[role]}\n"
            (conf_dir / "agents" / f"{role}.md").write_text(body.replace("---\n", header, 1))

    def run(self, role: str, prompt: str) -> StepResult:
        model = self.experiment.models[role]
        res = self.sandbox.exec(["opencode", "run", "--agent", role, "--format", "json", prompt], env=_env(self.run_id))
        _save_raw(self.sandbox, role, res.stdout, res.stderr)
        step = StepResult(role, model, self.name, res.exit_code, round(res.duration_s, 1))
        texts: list[str] = []
        cost = 0.0
        for line in res.stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind, part = event.get("type"), event.get("part") or {}
            if kind == "tool_use":
                step.tool_calls += 1
            elif kind == "text" and part.get("text"):
                texts.append(part["text"])
            elif kind == "step_finish":
                step.steps += 1
                _add_tokens(step.tokens, part.get("tokens") or {})
                cost += float(part.get("cost") or 0)
            elif kind == "error":
                step.error += json.dumps(event.get("error") or event)[:1000] + "\n"
        step.text = "\n".join(texts)
        step.cost = round(cost, 6) or None
        if res.timed_out:
            step.error += "step timed out\n"
        if res.exit_code != 0:
            step.error += res.stderr[-2000:]
        if res.exit_code == 0 and not step.text and step.steps == 0:
            step.error += "empty run: no output and no steps\n"
        _classify(step)
        return step


class DeepSeekHarness:
    name = "dsh"

    def __init__(self, sandbox: Sandbox, experiment: Experiment, run_id: str):
        self.sandbox, self.experiment, self.run_id = sandbox, experiment, run_id

    def setup(self) -> None:
        (self.sandbox.home / ".dsh" / "profiles" / "headless").mkdir(parents=True, exist_ok=True)

    def run(self, role: str, prompt: str) -> StepResult:
        model = self.experiment.models[role]
        profile = Template(DSH_TEMPLATE.read_text()).substitute(
            base_url=os.environ["LITELLM_BASE_URL"],
            run_id=self.run_id,
            model=model,
            context=self.experiment.model_context(model),
        )
        (self.sandbox.home / ".dsh" / "profiles" / "headless" / "cordis.patch.yml").write_text(profile)
        instructions = (AGENTS_DIR / f"{role_prompt_file(role)}.md").read_text().split("---\n", 2)[-1]
        env = {**_env(self.run_id), "DSH_HOME": f"{HOME}/.dsh"}
        res = self.sandbox.exec(["dsh", "--profile", "headless", "--json", f"{instructions}\n\n{prompt}"], env=env)
        _save_raw(self.sandbox, role, res.stdout, res.stderr)
        step = StepResult(role, model, self.name, res.exit_code, round(res.duration_s, 1))
        session_id = None
        for line in res.stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = event.get("type")
            if kind == "tool_call":
                step.tool_calls += 1
            elif kind == "status" and event.get("phase") == "step_start":
                step.steps += 1
            elif kind == "session":
                session_id = event.get("sessionId")
            elif kind == "final":
                step.text = str(event.get("text") or event.get("content") or "")
            elif kind == "error":
                step.error += json.dumps(event)[:1000] + "\n"
        if session_id:
            step.tokens = self._session_tokens(session_id)
        if res.timed_out:
            step.error += "step timed out\n"
        if res.exit_code != 0:
            step.error += res.stderr[-2000:]
        _classify(step)
        return step

    def _session_tokens(self, session_id: str) -> dict[str, int]:
        """The --json stream carries no usage; sum it from the session log."""
        tokens: dict[str, int] = {}
        for path in (self.sandbox.home / ".dsh" / "sessions").glob(f"*/{session_id}/session.*.jsonl.zstd"):
            with path.open("rb") as fh, zstandard.ZstdDecompressor().stream_reader(fh) as reader:
                for line in io.TextIOWrapper(reader, encoding="utf-8"):
                    event = json.loads(line) if line.strip() else {}
                    if event.get("type") == "assistant/message":
                        usage = event.get("data", {}).get("usage") or {}
                        for src, key in (("inputTokens", "input"), ("outputTokens", "output"),
                                         ("cacheReadTokens", "cache_read"), ("cacheWriteTokens", "cache_write")):
                            tokens[key] = tokens.get(key, 0) + int(usage.get(src) or 0)
        return tokens


HARNESSES = {"opencode": OpenCode, "dsh": DeepSeekHarness}


def make_harness(sandbox: Sandbox, experiment: Experiment, run_id: str):
    return HARNESSES[experiment.harness](sandbox, experiment, run_id)
