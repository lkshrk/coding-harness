from __future__ import annotations

import re
import subprocess
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from nightshift_eval.repo_rules import Kind, RepoRules

LINEAR_REF = re.compile(r"\b[A-Z][A-Z0-9]{1,6}-\d+\b")


@dataclass(frozen=True)
class PullRequest:
    number: int
    title: str
    body: str
    merge_sha: str | None
    paths: tuple[str, ...]
    changed_lines: int
    linear_refs: tuple[str, ...]


@dataclass(frozen=True)
class Patches:
    base: str
    merge: str
    parts: tuple[str, ...]
    source_files: tuple[str, ...]
    test_files: tuple[str, ...]
    gold_patch: str
    test_patch: str


def parse_prs(raw: Iterable[dict[str, Any]]) -> list[PullRequest]:
    prs = []
    for r in raw:
        text = f"{r.get('title', '')}\n{r.get('body') or ''}"
        refs = tuple(dict.fromkeys(LINEAR_REF.findall(text)))
        merge = r.get("mergeCommit") or {}
        prs.append(
            PullRequest(
                number=r["number"],
                title=r.get("title", ""),
                body=r.get("body") or "",
                merge_sha=merge.get("oid"),
                paths=tuple(f["path"] for f in r.get("files") or []),
                changed_lines=int(r.get("additions", 0)) + int(r.get("deletions", 0)),
                linear_refs=refs,
            )
        )
    return prs


def _split(paths: Iterable[str], rules: RepoRules) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    sources: dict[str, list[str]] = {}
    tests: dict[str, list[str]] = {}
    for path in paths:
        kind, part = rules.classify(path)
        if part is None:
            continue
        target = tests if kind is Kind.TEST else sources
        target.setdefault(part, []).append(path)
    return sources, tests


def select_candidates(prs: Iterable[PullRequest], rules: RepoRules, max_lines: int) -> list[PullRequest]:
    selected = []
    for pr in prs:
        if pr.merge_sha is None or pr.changed_lines > max_lines:
            continue
        sources, tests = _split(pr.paths, rules)
        if set(sources) & set(tests):
            selected.append(pr)
    return selected


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout


def patches_for(repo: Path, pr: PullRequest, rules: RepoRules) -> Patches:
    if pr.merge_sha is None:
        raise ValueError(f"PR {pr.number} has no merge commit")
    merge = pr.merge_sha
    base = _git(repo, "rev-parse", f"{merge}^1").strip()
    changed = [p for p in _git(repo, "diff", "--name-only", base, merge).splitlines() if p]
    sources, tests = _split(changed, rules)
    parts = tuple(sorted(set(sources) & set(tests)))
    source_files = tuple(f for part in parts for f in sources[part])
    test_files = tuple(f for part in parts for f in tests[part])
    return Patches(
        base=base,
        merge=merge,
        parts=parts,
        source_files=source_files,
        test_files=test_files,
        gold_patch=_git(repo, "diff", "--binary", base, merge, "--", *source_files),
        test_patch=_git(repo, "diff", "--binary", base, merge, "--", *test_files),
    )
