from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from nightshift_eval.harbor import emit_task
from nightshift_eval.mine import parse_prs, patches_for, select_candidates
from nightshift_eval.repo_rules import RULES
from nightshift_eval.validate import validate_task

GH_FIELDS = "number,title,body,mergeCommit,files,additions,deletions"


def _load_prs(repo: Path, prs_json: Path | None, limit: int) -> list[dict[str, Any]]:
    if prs_json is not None:
        data: list[dict[str, Any]] = json.loads(prs_json.read_text())
        return data
    out = subprocess.run(
        ["gh", "pr", "list", "--state", "merged", "--limit", str(limit), "--json", GH_FIELDS],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
    ).stdout
    result: list[dict[str, Any]] = json.loads(out)
    return result


def _mine(args: argparse.Namespace) -> int:
    rules = RULES.get(args.rules)
    if rules is None:
        print(f"unknown rules: {args.rules}", file=sys.stderr)
        return 2
    repo = Path(args.repo).expanduser()
    prs = parse_prs(_load_prs(repo, Path(args.prs_json) if args.prs_json else None, args.limit))
    candidates = select_candidates(prs, rules, max_lines=args.max_lines)
    emitted = 0
    skipped: list[dict[str, Any]] = []
    for pr in candidates:
        try:
            patches = patches_for(repo, pr, rules)
        except subprocess.CalledProcessError as e:
            skipped.append({"pr": pr.number, "reason": (e.stderr or str(e)).strip()[:200]})
            continue
        if not patches.parts:
            skipped.append({"pr": pr.number, "reason": "no part with both source and test changes"})
            continue
        emit_task(Path(args.out), pr, patches, rules, repo_url=args.repo_url, repo_path=repo)
        emitted += 1
    print(
        json.dumps({"prs": len(prs), "candidates": len(candidates), "emitted": emitted, "skipped": skipped})
    )
    return 0


def _validate(args: argparse.Namespace) -> int:
    counts: dict[str, int] = {}
    for t in args.tasks:
        v = validate_task(Path(t), repeats=args.repeats)
        counts[v.verdict] = counts.get(v.verdict, 0) + 1
        print(
            json.dumps(
                {
                    "task": v.task,
                    "verdict": v.verdict,
                    "without": v.without_gold,
                    "with": v.with_gold,
                    "build_s": v.build_seconds,
                }
            ),
            flush=True,
        )
    print(json.dumps({"summary": counts}))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nightshift-eval")
    sub = parser.add_subparsers(dest="command", required=True)
    mine = sub.add_parser("mine", help="turn merged pull requests into Harbor tasks")
    mine.add_argument("--repo", required=True)
    mine.add_argument("--rules", required=True)
    mine.add_argument("--repo-url", required=True)
    mine.add_argument("--out", required=True)
    mine.add_argument("--limit", type=int, default=500)
    mine.add_argument("--max-lines", type=int, default=600)
    mine.add_argument("--prs-json")
    validate = sub.add_parser(
        "validate", help="check that hidden tests fail without and pass with the gold patch"
    )
    validate.add_argument("tasks", nargs="+")
    validate.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args(argv)
    if args.command == "mine":
        return _mine(args)
    if args.command == "validate":
        return _validate(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
