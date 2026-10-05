from conftest import gh_pr, git

from nightshift_eval.mine import PullRequest, parse_prs, patches_for, select_candidates
from nightshift_eval.repo_rules import ROUTIVO


def test_parse_prs_reads_gh_json():
    [pr] = parse_prs([gh_pr(12, "abc", ["backend/app/calc.py"])])
    assert pr == PullRequest(
        number=12,
        title="ROU-7: add mul (#12)",
        body="## Summary\nAdds mul to calc.",
        merge_sha="abc",
        paths=("backend/app/calc.py",),
        changed_lines=10,
        linear_refs=("ROU-7",),
    )


def test_select_keeps_prs_with_source_and_tests_of_the_same_part():
    prs = parse_prs(
        [
            gh_pr(1, "a", ["backend/app/calc.py", "backend/tests/test_calc.py"]),
            gh_pr(2, "b", ["backend/app/calc.py"]),
            gh_pr(3, "c", ["backend/app/calc.py", "frontend/src/lib/x.test.ts"]),
            gh_pr(4, None, ["backend/app/calc.py", "backend/tests/test_calc.py"]),
            gh_pr(5, "e", ["backend/app/calc.py", "backend/tests/test_calc.py"], additions=700),
            gh_pr(6, "f", ["deploy/k8s/job.yaml", "backend/tests/test_calc.py"]),
        ]
    )
    assert [p.number for p in select_candidates(prs, ROUTIVO, max_lines=600)] == [1]


def test_patches_split_tests_from_source_and_drop_other_files(repo):
    path, merge = repo
    [pr] = parse_prs(
        [gh_pr(12, merge, ["backend/app/calc.py", "backend/tests/test_calc.py", "ARCHITECTURE.md"])]
    )
    p = patches_for(path, pr, ROUTIVO)
    assert p.base == git(path, "rev-parse", f"{merge}^1").strip()
    assert p.parts == ("backend",)
    assert p.test_files == ("backend/tests/test_calc.py",)
    assert "def mul" in p.gold_patch and "test_mul" not in p.gold_patch
    assert "test_mul" in p.test_patch and "def mul" not in p.test_patch
    assert "ARCHITECTURE.md" not in p.gold_patch + p.test_patch
