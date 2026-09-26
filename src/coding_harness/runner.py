from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from datetime import UTC, datetime

from .config import ROOT, Experiment, Task
from .harness import StepResult, make_harness
from .sandbox import Sandbox
from .tracing import A, Kind, fail, flush, ids, set_attributes, span
from .verify import Verification, verify

RUNS_DIR = ROOT / "runs"
MAX_DIFF = 12000
VERDICT = re.compile(r"VERDICT:\s*(PASS|FAIL)", re.IGNORECASE)


class Run:
    def __init__(self, task: Task, experiment: Experiment):
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
        self.run_id = f"{task.id}.{experiment.name}.{stamp}"
        self.dir = RUNS_DIR / self.run_id
        self.task, self.experiment = task, experiment
        self.sandbox = Sandbox(self.dir, task)
        self.harness = make_harness(self.sandbox, experiment, self.run_id)
        self.steps: list[StepResult] = []
        self.escalations: list[dict] = []
        self.verifications: list[dict] = []
        self.attempts: list[str] = []

    def call(self, role: str, prompt: str) -> StepResult:
        """Infra failures are retried on the same role and never count as an attempt."""
        for _ in range(self.experiment.policy["infra_retries"] + 1):
            with span(role, Kind.AGENT, self.run_id, **{A.INPUT_VALUE: prompt}) as current:
                step = self.harness.run(role, prompt)
                set_attributes(current, **{
                    A.LLM_MODEL_NAME: step.model,
                    A.OUTPUT_VALUE: step.text or step.error,
                    A.LLM_TOKEN_COUNT_PROMPT: step.tokens.get("input"),
                    A.LLM_TOKEN_COUNT_COMPLETION: step.tokens.get("output"),
                    A.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ: step.tokens.get("cache_read"),
                    "harness.name": step.harness,
                    "harness.tool_calls": step.tool_calls,
                    "harness.steps": step.steps,
                    "harness.failure": step.failure,
                })
                if step.failure:
                    fail(current, f"{step.failure}: {step.error}")
            self.steps.append(step)
            self._log(step.record())
            if step.failure != "infra":
                break
        return step

    def check(self, label: str, checks: list[dict[str, str]] | None = None) -> Verification:
        with span(f"checks:{label}", Kind.TOOL, self.run_id) as current:
            result = verify(self.sandbox, checks or self.task.verify)
            set_attributes(current, **{
                A.OUTPUT_VALUE: result.feedback() or "all checks passed",
                "checks.passed": result.passed,
                "checks.ran": [c.name for c in result.checks],
            })
            if not result.passed:
                fail(current, result.failed.name if result.failed else "no checks ran")
        self.verifications.append({"after": label, "passed": result.passed, "checks": result.record()})
        return result

    def _log(self, entry: dict) -> None:
        with (self.dir / "steps.jsonl").open("a") as fh:
            fh.write(json.dumps(entry) + "\n")

    def diff(self) -> str:
        diff = self.sandbox.diff()
        return diff if len(diff) <= MAX_DIFF else diff[:MAX_DIFF] + "\n[diff truncated]"

    def brief(self, result: Verification) -> str:
        tried = "\n".join(f"- {a}" for a in self.attempts) or "- none"
        return (
            f"TASK:\n{self.task.prompt}\n\nEARLIER ATTEMPTS:\n{tried}\n\n"
            f"CURRENT DIFF:\n```diff\n{self.diff()}\n```\n\nFAILING CHECK:\n{result.feedback()}"
        )

    def attempt(self, role: str, prompt: str) -> Verification:
        step = self.call(role, prompt)
        result = self.check(f"{role}#{len(self.attempts) + 1}")
        outcome = "checks passed" if result.passed else (result.failed.name if result.failed else "no checks ran")
        note = (step.error if step.failure else step.text).strip()[:200].replace("\n", " ")
        self.attempts.append(f"{role} ({step.model}): {outcome}. {note}")
        return result

    def execute(self) -> dict:
        self.dir.mkdir(parents=True)
        self.spend_before = key_spend()
        started = time.monotonic()
        self.sandbox.prepare()
        self.sandbox.start()
        self.sandbox.run_setup()
        root_attrs = {
            A.INPUT_VALUE: self.task.prompt,
            A.METADATA: {"task": self.task.id, "category": self.task.category, "experiment": self.experiment.name,
                         "harness": self.experiment.harness, "models": self.experiment.models},
        }
        try:
            with span(f"run:{self.task.id}", Kind.CHAIN, self.run_id, **root_attrs) as root:
                self.trace = ids(root)
                self.harness.setup()
                summary = self._execute(started)
                set_attributes(root, **{
                    A.OUTPUT_VALUE: {k: summary[k] for k in ("outcome", "checks_passed", "hidden_tests_passed",
                                                             "review_verdict", "escalations", "cost_usd")},
                    "run.outcome": summary["outcome"],
                    "run.cost_usd": summary["cost_usd"],
                    "run.frontier_used": summary["frontier_used"],
                })
                if summary["outcome"] != "success":
                    fail(root, "task not solved")
            return summary
        finally:
            flush()
            self.sandbox.stop()

    def _execute(self, started: float) -> dict:
        models, policy = self.experiment.models, self.experiment.policy
        context = ""
        if "explorer" in models:
            report = self.call("explorer", f"TASK:\n{self.task.prompt}")
            if not report.failure:
                context = f"\n\nCONTEXT FROM REPOSITORY SCOUT:\n{report.text}"

        result = self.attempt("coder", f"TASK:\n{self.task.prompt}{context}")
        for _ in range(policy["coder_retries"]):
            if result.passed:
                break
            result = self.attempt(
                "coder",
                f"TASK:\n{self.task.prompt}\n\nYour change does not pass the repository checks yet. "
                f"Fix it.\n\n{result.feedback()}",
            )

        for role, limit in (("debugger", policy["debugger_attempts"]), ("escalation", policy["escalation_attempts"])):
            if role not in models:
                continue
            for _ in range(limit):
                if result.passed:
                    break
                failed = result.failed.name if result.failed else "no checks"
                self.escalations.append({"to": role, "model": models[role], "reason": f"{failed} still failing",
                                         "after_attempts": len(self.attempts)})
                result = self.attempt(role, self.brief(result))

        final_diff = self.sandbox.diff()
        (self.dir / "final.diff").write_text(final_diff)
        hidden = None
        if result.passed and (self.task.hidden_tests or self.task.hidden_test_patch):
            self.sandbox.restore_hidden_tests()
            hidden = self.check("hidden-tests", self.task.hidden_verify).passed

        verdict = None
        if result.passed and "reviewer" in models:
            review = self.call(
                "reviewer",
                f"TASK:\n{self.task.prompt}\n\nCHANGE UNDER REVIEW:\n```diff\n{final_diff[:MAX_DIFF]}\n```",
            )
            match = VERDICT.search(review.text)
            verdict = match.group(1).upper() if match else "NONE"

        success = result.passed and hidden is not False
        summary = self.summary(success, result.passed, hidden, verdict, time.monotonic() - started)
        (self.dir / "result.json").write_text(json.dumps(summary, indent=2))
        return summary

    def run_cost(self) -> float | None:
        if self.spend_before is None:
            return None
        time.sleep(SPEND_SETTLE_S)  # LiteLLM books spend in batches
        after = key_spend()
        return None if after is None else round(after - self.spend_before, 6)

    def summary(self, success: bool, checks: bool, hidden: bool | None, verdict: str | None, wall: float) -> dict:
        tokens: dict[str, int] = {}
        for step in self.steps:
            for key, value in step.tokens.items():
                tokens[key] = tokens.get(key, 0) + value
        costs = [s.cost for s in self.steps if s.cost is not None]
        return {
            "run_id": self.run_id,
            "trace": self.trace,
            "task": self.task.id,
            "category": self.task.category,
            "experiment": self.experiment.name,
            "harness": self.experiment.harness,
            "models": self.experiment.models,
            "outcome": "success" if success else "failure",
            "checks_passed": checks,
            "hidden_tests_passed": hidden,
            "review_verdict": verdict,
            "review_agrees": None if verdict in (None, "NONE") else (verdict == "PASS") == success,
            "attempts": len(self.attempts),
            "escalations": self.escalations,
            "frontier_used": any(s.role == "escalation" for s in self.steps),
            "infra_failures": sum(s.failure == "infra" for s in self.steps),
            "model_failures": sum(s.failure == "model" for s in self.steps),
            "model_turns": sum(s.steps for s in self.steps),
            "tool_calls": sum(s.tool_calls for s in self.steps),
            "tokens": tokens,
            "cost_usd": self.run_cost(),
            "harness_cost_usd": round(sum(costs), 6) if costs else None,
            "wall_s": round(wall, 1),
            "human_intervention": None,
            "steps": [s.record() for s in self.steps],
            "verifications": self.verifications,
        }


SPEND_SETTLE_S = 20


def key_spend() -> float | None:
    """Total spend LiteLLM has booked on the harness key; runs are sequential, so the delta is the run's cost."""
    base = os.environ["LITELLM_BASE_URL"].rstrip("/").removesuffix("/v1")
    request = urllib.request.Request(f"{base}/key/info", headers={"Authorization": f"Bearer {os.environ['LITELLM_API_KEY']}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return float(json.load(response)["info"].get("spend") or 0)
    except (OSError, ValueError, KeyError):  # cost unknown rather than wrong
        return None


def run_task(task: Task, experiment: Experiment) -> dict:
    return Run(task, experiment).execute()
