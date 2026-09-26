from __future__ import annotations

import shlex
import tempfile
from pathlib import Path

from .config import Task, benchmark_tasks
from .sandbox import Sandbox
from .verify import verify


def validate_task(task: Task) -> list[str]:
    """A usable task: checks pass on base, hidden tests fail on base, everything passes on reference."""
    problems: list[str] = []
    sandbox = Sandbox(Path(tempfile.mkdtemp(prefix=f"validate-{task.id}-")), task)
    sandbox.prepare()
    sandbox.start()
    try:
        if not verify(sandbox, task.verify).passed:
            problems.append("checks already fail on base (agent would inherit a broken tree)")
        if task.hidden_tests:
            sandbox.restore_hidden_tests()
            if verify(sandbox, task.verify).passed:
                problems.append("hidden tests pass on base: they do not detect the missing change")
        if task.reference:
            checkout = sandbox.sh(f"git checkout --quiet --force {shlex.quote(task.reference)}")
            if checkout.exit_code != 0:
                problems.append(f"cannot check out reference: {checkout.stderr.strip()}")
            elif not (result := verify(sandbox, task.verify)).passed:
                problems.append(f"reference fails its own checks: {result.feedback()[-500:]}")
    finally:
        sandbox.stop()
    return problems


def validate_tasks(ids: list[str]) -> bool:
    ok = True
    for task in benchmark_tasks():
        if ids and task.id not in ids:
            continue
        problems = validate_task(task)
        ok &= not problems
        print(f"{'ok  ' if not problems else 'FAIL'} {task.id}")
        for problem in problems:
            print(f"     - {problem}")
    return ok
