from __future__ import annotations

from dataclasses import dataclass, field

from .sandbox import Sandbox


@dataclass
class CheckResult:
    name: str
    run: str
    exit_code: int
    duration_s: float
    output_tail: str


@dataclass
class Verification:
    checks: list[CheckResult] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return bool(self.checks) and all(c.exit_code == 0 for c in self.checks)

    @property
    def failed(self) -> CheckResult | None:
        return next((c for c in self.checks if c.exit_code != 0), None)

    def feedback(self) -> str:
        failed = self.failed
        if not failed:
            return ""
        return (
            f"Check `{failed.name}` failed.\n$ {failed.run}\n(exit {failed.exit_code})\n{failed.output_tail}"
        )

    def record(self) -> list[dict]:
        return [c.__dict__ for c in self.checks]


def verify(sandbox: Sandbox, checks: list[dict[str, str]]) -> Verification:
    """Run the task's checks in order and stop at the first failure."""
    result = Verification()
    for check in checks:
        res = sandbox.sh(check["run"])
        output = (res.stdout + res.stderr)[-4000:]
        result.checks.append(
            CheckResult(check["name"], check["run"], res.exit_code, round(res.duration_s, 1), output)
        )
        if res.exit_code != 0:
            break
    return result
