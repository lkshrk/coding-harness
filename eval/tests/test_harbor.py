import os
import subprocess
import tomllib

from conftest import gh_pr, git

from nightshift_eval.harbor import emit_task
from nightshift_eval.mine import parse_prs, patches_for
from nightshift_eval.repo_rules import ROUTIVO


def emitted(repo, tmp_path):
    path, merge = repo
    [pr] = parse_prs([gh_pr(12, merge, ["backend/app/calc.py", "backend/tests/test_calc.py"])])
    patches = patches_for(path, pr, ROUTIVO)
    out = emit_task(
        tmp_path / "tasks",
        pr,
        patches,
        ROUTIVO,
        repo_url="https://github.com/routivo/routivo-monorepo",
        repo_path=path,
    )
    return path, patches, out


def test_task_directory_has_harbor_layout(repo, tmp_path):
    _, _, out = emitted(repo, tmp_path)
    assert out.name == "routivo-pr-12"
    for rel in [
        "instruction.md",
        "task.toml",
        "environment/Dockerfile",
        "solution/solve.sh",
        "solution/gold.patch",
        "tests/test.sh",
        "tests/test.patch",
    ]:
        assert (out / rel).is_file(), rel
    assert os.access(out / "tests/test.sh", os.X_OK)
    assert os.access(out / "solution/solve.sh", os.X_OK)


def test_task_toml_carries_provenance(repo, tmp_path):
    _, patches, out = emitted(repo, tmp_path)
    meta = tomllib.loads((out / "task.toml").read_text())
    assert meta["task"]["name"] == "nightshift/routivo-pr-12"
    ns = meta["metadata"]["nightshift"]
    assert ns["repo"] == "https://github.com/routivo/routivo-monorepo"
    assert ns["pr"] == 12
    assert ns["base"] == patches.base
    assert ns["merge"] == patches.merge
    assert ns["parts"] == ["backend"]
    assert ns["linear_refs"] == ["ROU-7"]
    assert ns["needs_rewrite"] is True


def test_instruction_does_not_leak_the_solution(repo, tmp_path):
    _, _, out = emitted(repo, tmp_path)
    text = (out / "instruction.md").read_text()
    assert "add mul" in text
    assert "def mul" not in text and "test_mul" not in text


def test_verifier_runs_only_the_changed_tests(repo, tmp_path):
    _, _, out = emitted(repo, tmp_path)
    script = (out / "tests/test.sh").read_text()
    assert "git apply /tests/test.patch" in script
    assert "uv run pytest -q tests/test_calc.py" in script
    assert "/logs/verifier/reward.txt" in script


def test_gold_and_test_patch_reproduce_the_merge(repo, tmp_path):
    path, patches, out = emitted(repo, tmp_path)
    work = tmp_path / "work"
    subprocess.run(["git", "clone", "-q", str(path), str(work)], check=True)
    git(work, "checkout", "-q", patches.base)
    git(work, "apply", str(out / "solution/gold.patch"))
    git(work, "apply", str(out / "tests/test.patch"))
    for f in patches.source_files + patches.test_files:
        assert (work / f).read_text() == git(path, "show", f"{patches.merge}:{f}")


def test_environment_carries_the_base_tree_without_history(repo, tmp_path):
    import tarfile

    path, patches, out = emitted(repo, tmp_path)
    with tarfile.open(out / "environment/repo.tar") as tar:
        names = tar.getnames()
    assert "backend/app/calc.py" in names
    assert not any(n == ".git" or n.startswith(".git/") for n in names)
    with tarfile.open(out / "environment/repo.tar") as tar:
        member = tar.extractfile("backend/app/calc.py")
        assert member is not None
        assert "def mul" not in member.read().decode()


def test_task_dockerfile_installs_dependencies_of_the_touched_parts_only(repo, tmp_path):
    _, _, out = emitted(repo, tmp_path)
    dockerfile = (out / "environment/Dockerfile").read_text()
    assert dockerfile.startswith("FROM nightshift/routivo-env:base\n")
    assert "git commit -qm base" in dockerfile
    assert "uv sync --frozen" in dockerfile
    assert "pnpm install" not in dockerfile
