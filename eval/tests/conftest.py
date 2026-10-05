import subprocess
from pathlib import Path

import pytest


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout


@pytest.fixture
def repo(tmp_path: Path) -> tuple[Path, str]:
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.email", "t@example.com")
    git(tmp_path, "config", "user.name", "t")
    (tmp_path / "backend/app").mkdir(parents=True)
    (tmp_path / "backend/tests").mkdir(parents=True)
    (tmp_path / "backend/app/calc.py").write_text("def add(a, b):\n    return a + b\n")
    (tmp_path / "backend/tests/test_calc.py").write_text(
        "from app.calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n"
    )
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-qm", "base")
    (tmp_path / "backend/app/calc.py").write_text(
        "def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n"
    )
    (tmp_path / "backend/tests/test_calc.py").write_text(
        "from app.calc import add, mul\n\n\ndef test_add():\n    assert add(1, 2) == 3\n\n\ndef test_mul():\n    assert mul(2, 3) == 6\n"
    )
    (tmp_path / "ARCHITECTURE.md").write_text("calc gains mul\n")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-qm", "ROU-7: add mul (#12)")
    return tmp_path, git(tmp_path, "rev-parse", "HEAD").strip()


def gh_pr(
    number: int, merge_sha: str | None, paths: list[str], additions: int = 10, deletions: int = 0
) -> dict:
    return {
        "number": number,
        "title": f"ROU-7: add mul (#{number})",
        "body": "## Summary\nAdds mul to calc.",
        "mergeCommit": {"oid": merge_sha} if merge_sha else None,
        "files": [{"path": p} for p in paths],
        "additions": additions,
        "deletions": deletions,
    }
