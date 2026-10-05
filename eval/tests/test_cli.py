import json

from conftest import gh_pr

from nightshift_eval.cli import main


def test_mine_writes_one_task_per_candidate_and_a_summary(repo, tmp_path, capsys):
    path, merge = repo
    prs_file = tmp_path / "prs.json"
    prs_file.write_text(
        json.dumps(
            [
                gh_pr(12, merge, ["backend/app/calc.py", "backend/tests/test_calc.py"]),
                gh_pr(13, merge, ["ARCHITECTURE.md"]),
            ]
        )
    )
    out = tmp_path / "tasks"
    code = main(
        [
            "mine",
            "--repo",
            str(path),
            "--rules",
            "routivo",
            "--repo-url",
            "https://github.com/routivo/routivo-monorepo",
            "--prs-json",
            str(prs_file),
            "--out",
            str(out),
        ]
    )
    assert code == 0
    assert sorted(p.name for p in out.iterdir()) == ["routivo-pr-12"]
    summary = json.loads(capsys.readouterr().out)
    assert summary == {"prs": 2, "candidates": 1, "emitted": 1, "skipped": []}


def test_unknown_rules_exit_2(tmp_path, capsys):
    code = main(
        ["mine", "--repo", str(tmp_path), "--rules", "nope", "--repo-url", "x", "--out", str(tmp_path)]
    )
    assert code == 2
    assert "unknown rules: nope" in capsys.readouterr().err
