from __future__ import annotations

import json
import subprocess
import time
from dataclasses import asdict, dataclass
from enum import StrEnum
from pathlib import Path


class Verdict(StrEnum):
    VALID = "valid"
    ALREADY_PASSING = "already_passing"
    STILL_FAILING = "still_failing"
    FLAKY = "flaky"
    INVERTED = "inverted"
    BUILD_FAILED = "build_failed"


def classify(without_gold: list[int], with_gold: list[int]) -> Verdict:
    if not without_gold or not with_gold:
        raise ValueError("classification needs at least one run with and without the gold patch")
    if len(set(without_gold)) > 1 or len(set(with_gold)) > 1:
        return Verdict.FLAKY
    before, after = without_gold[0], with_gold[0]
    if before == 0 and after == 1:
        return Verdict.VALID
    if before == 1 and after == 1:
        return Verdict.ALREADY_PASSING
    if before == 0 and after == 0:
        return Verdict.STILL_FAILING
    return Verdict.INVERTED


@dataclass(frozen=True)
class Validation:
    task: str
    verdict: Verdict
    without_gold: list[int]
    with_gold: list[int]
    build_seconds: float
    detail: str = ""


def _run(cmd: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)


def _reward(image: str, task: Path, gold: bool, timeout: float) -> int:
    script = (
        "bash /solution/solve.sh && " if gold else ""
    ) + "bash /tests/test.sh; cat /logs/verifier/reward.txt"
    result = _run(
        [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{(task / 'tests').resolve()}:/tests:ro",
            "-v",
            f"{(task / 'solution').resolve()}:/solution:ro",
            image,
            "bash",
            "-c",
            script,
        ],
        timeout,
    )
    last = result.stdout.strip().splitlines()[-1:] or ["0"]
    return 1 if last[0].strip() == "1" else 0


def validate_task(task: Path, repeats: int = 3, timeout: float = 900) -> Validation:
    image = f"nightshift-task/{task.name}:latest"
    start = time.monotonic()
    build = _run(["docker", "build", "-q", "-t", image, str(task / "environment")], timeout)
    build_seconds = round(time.monotonic() - start, 1)
    if build.returncode != 0:
        return Validation(task.name, Verdict.BUILD_FAILED, [], [], build_seconds, build.stderr[-2000:])
    without = [_reward(image, task, gold=False, timeout=timeout) for _ in range(repeats)]
    with_gold = [_reward(image, task, gold=True, timeout=timeout) for _ in range(repeats)]
    result = Validation(task.name, classify(without, with_gold), without, with_gold, build_seconds)
    (task / "validation.json").write_text(json.dumps(asdict(result), indent=2) + "\n")
    return result
