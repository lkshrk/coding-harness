from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from .config import Task, benchmark_tasks
from .sandbox import BASE_REF, Sandbox
from .verify import verify


def validate_task(task: Task) -> list[str]:
    """A usable task: checks pass on base, hidden tests fail on base, everything passes on reference."""
    problems: list[str] = []
    sandbox = Sandbox(Path(tempfile.mkdtemp(prefix=f"validate-{task.id}-")), task)
    sandbox.prepare()
    sandbox.start()
    try:
        sandbox.run_setup()
        if not verify(sandbox, task.verify).passed:
            problems.append("checks already fail on base (agent would inherit a broken tree)")
        if task.hidden_tests or task.hidden_test_patch:
            sandbox.restore_hidden_tests()
            if verify(sandbox, task.hidden_verify or task.verify).passed:
                problems.append("hidden tests pass on base: they do not detect the missing change")
        if task.reference_patch:
            sandbox.sh(f"git checkout --quiet --force {BASE_REF} && git clean -fdq")
            sandbox.apply_patch(task.reference_patch)
            if task.hidden_test_patch:
                sandbox.apply_patch(task.hidden_test_patch, reset_files_to_base=True)
            if not (result := verify(sandbox, task.hidden_verify or task.verify)).passed:
                problems.append(f"reference fails its own checks: {result.feedback()[-500:]}")
        elif task.reference:
            try:
                sandbox.checkout_reference()
            except subprocess.CalledProcessError as exc:
                problems.append(f"cannot check out reference: {exc}")
            else:
                if not (result := verify(sandbox, task.verify)).passed:
                    problems.append(f"reference fails its own checks: {result.feedback()[-500:]}")
    finally:
        sandbox.stop()
    return problems


def validate_tasks(ids: list[str]) -> bool:
    ok = True
    for task in benchmark_tasks():
        if ids and task.id not in ids:
            continue
        try:
            problems = validate_task(task)
        except RuntimeError as exc:  # setup or patch failure: report the task, keep validating the rest
            problems = [str(exc)[:500]]
        ok &= not problems
        print(f"{'ok  ' if not problems else 'FAIL'} {task.id}")
        for problem in problems:
            print(f"     - {problem}")
    return ok
