import subprocess

import pytest

from nightshift_eval.repo_rules import ROUTIVO, Kind


@pytest.mark.parametrize(
    ("path", "kind", "part"),
    [
        ("backend/tests/api/test_camper.py", Kind.TEST, "backend"),
        ("backend/tests/conftest.py", Kind.TEST, "backend"),
        ("backend/app/api/v1/camper.py", Kind.SOURCE, "backend"),
        ("backend/alembic/versions/e1a4c7b92d30_camper.py", Kind.SOURCE, "backend"),
        ("frontend/src/lib/components/planner/Map.test.ts", Kind.TEST, "frontend"),
        ("frontend/eslint-local-rules/theme-rules.test.ts", Kind.TEST, "frontend"),
        ("frontend/src/lib/components/planner/Map.svelte", Kind.SOURCE, "frontend"),
        ("frontend/messages/de.json", Kind.SOURCE, "frontend"),
        ("deploy/k8s/cronjob.yaml", Kind.OTHER, None),
        ("ARCHITECTURE.md", Kind.OTHER, None),
        ("e2e/tests/planner/route.spec.ts", Kind.OTHER, None),
    ],
)
def test_classifies_routivo_paths(path, kind, part):
    assert ROUTIVO.classify(path) == (kind, part)


def test_test_command_receives_only_that_parts_files():
    cmd = ROUTIVO.test_command("backend", ["backend/tests/api/test_camper.py"])
    assert cmd == "cd backend && env -u ROUTIVO_DATABASE_URL uv run pytest -q tests/api/test_camper.py"


def test_frontend_command_compiles_messages_before_vitest():
    cmd = ROUTIVO.test_command("frontend", ["frontend/src/lib/a.test.ts"])
    assert cmd.startswith("cd frontend && pnpm exec paraglide-js compile")
    assert cmd.endswith("VITEST=1 pnpm exec vitest run src/lib/a.test.ts")


def test_command_quotes_paths_bash_would_parse(tmp_path):
    cmd = ROUTIVO.test_command("frontend", ["frontend/src/routes/(admin)/adm/layout.server.test.ts"])
    script = tmp_path / "t.sh"
    script.write_text(f"if ( {cmd} ); then :; fi\n")
    assert subprocess.run(["bash", "-n", str(script)], capture_output=True).returncode == 0
    assert "'src/routes/(admin)/adm/layout.server.test.ts'" in cmd
