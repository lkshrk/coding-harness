from __future__ import annotations

import shlex
from dataclasses import dataclass
from enum import StrEnum
from fnmatch import fnmatchcase


class Kind(StrEnum):
    TEST = "test"
    SOURCE = "source"
    OTHER = "other"


@dataclass(frozen=True)
class Part:
    name: str
    root: str
    tests: tuple[str, ...]
    sources: tuple[str, ...]
    test_command: str
    setup: str
    cache: str


@dataclass(frozen=True)
class RepoRules:
    name: str
    base_image: str
    parts: tuple[Part, ...]

    def classify(self, path: str) -> tuple[Kind, str | None]:
        for part in self.parts:
            if any(fnmatchcase(path, p) for p in part.tests):
                return Kind.TEST, part.name
            if any(fnmatchcase(path, p) for p in part.sources):
                return Kind.SOURCE, part.name
        return Kind.OTHER, None

    def part(self, name: str) -> Part:
        return next(p for p in self.parts if p.name == name)

    def test_command(self, part_name: str, test_files: list[str]) -> str:
        part = self.part(part_name)
        prefix = part.root.rstrip("/") + "/"
        relative = [f.removeprefix(prefix) for f in test_files]
        return part.test_command.format(files=" ".join(shlex.quote(f) for f in relative))


ROUTIVO = RepoRules(
    name="routivo",
    base_image="nightshift/routivo-env:base",
    parts=(
        Part(
            name="backend",
            root="backend",
            tests=("backend/tests/*",),
            sources=("backend/app/*", "backend/alembic/*"),
            test_command="cd backend && env -u ROUTIVO_DATABASE_URL uv run pytest -q {files}",
            setup="cd backend && uv sync --frozen",
            cache="/root/.cache/uv",
        ),
        Part(
            name="frontend",
            root="frontend",
            tests=("frontend/*.test.ts", "frontend/*.spec.ts"),
            sources=("frontend/src/*", "frontend/messages/*"),
            test_command=(
                "cd frontend && pnpm exec paraglide-js compile --project ./project.inlang"
                " --outdir ./src/lib/paraglide && VITEST=1 pnpm exec vitest run {files}"
            ),
            setup="cd frontend && pnpm install --frozen-lockfile",
            cache="/root/.local/share/pnpm/store",
        ),
    ),
)

RULES = {ROUTIVO.name: ROUTIVO}
