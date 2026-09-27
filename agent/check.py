"""Validates the agent config that Coder workspaces sync from this folder.

Every workspace takes the default branch on its next start, so this runs in CI
here and in auto-code-env's template pipeline. Standard library only.
"""

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
AGENT_MODES = {"primary", "subagent", "all"}
MODELS = re.compile(r"^gw/(fast|coding|deep)$")
REPO = re.compile(r"^https://github\.com/[\w.-]+/[\w.-]+\.git$")


def frontmatter(path):
    text = path.read_text()
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end < 0:
        return None
    return dict(re.findall(r"^([a-z_]+):[ \t]*(.*)$", text[4:end], re.MULTILINE))


def check_markdown(kind, directory, errors):
    for path in sorted(directory.glob("*.md")):
        meta = frontmatter(path)
        name = path.relative_to(ROOT)
        if meta is None:
            errors.append(f"{name}: missing front matter")
            continue
        if not meta.get("description"):
            errors.append(f"{name}: missing description")
        if kind == "agent" and meta.get("mode") not in AGENT_MODES:
            errors.append(f"{name}: mode must be one of {sorted(AGENT_MODES)}")
        if meta.get("model") and not MODELS.match(meta["model"]):
            errors.append(f"{name}: model must be gw/fast, gw/coding or gw/deep")
        text = path.read_text()
        read_only = re.search(r"- action: edit\n\s+resource: \"\*\"\n\s+effect: deny", text)
        if kind == "agent" and read_only and 'action: "context-mode_ctx_*execute*"' not in text:
            errors.append(
                f"{name}: read-only agents must deny context-mode_ctx_*execute* (it runs arbitrary code)"
            )
        if kind == "command" and meta.get("agent") and meta["agent"] not in agents:
            errors.append(f"{name}: unknown agent {meta['agent']}")


def check_skill(path, errors, label):
    skill = path / "SKILL.md"
    meta = frontmatter(skill) if skill.exists() else None
    if meta is None or not meta.get("name") or not meta.get("description"):
        errors.append(f"{label}: SKILL.md with name and description required")


def check_manifest(errors, offline):
    try:
        skills = json.loads((ROOT / "skills.json").read_text())["skills"]
    except (OSError, ValueError, KeyError) as error:
        errors.append(f"skills.json: {error}")
        return
    names = set()
    own = {path.name for path in (ROOT / "skills").iterdir() if path.is_dir()}
    sources = {}
    for index, skill in enumerate(skills):
        label = f"skills.json[{index}]"
        if set(skill) != {"name", "repo", "ref", "path"}:
            errors.append(f"{label}: needs exactly name, repo, ref, path")
            continue
        if skill["name"] in names or skill["name"] in own:
            errors.append(f"{label}: duplicate skill {skill['name']}")
        names.add(skill["name"])
        if not REPO.match(skill["repo"]):
            errors.append(f"{label}: repo must be https://github.com/<owner>/<repo>.git")
        if not skill["ref"] or skill["ref"] in {"main", "master", "HEAD"}:
            errors.append(f"{label}: ref must be a tag or commit, not a branch")
        sources.setdefault((skill["repo"], skill["ref"]), []).append(skill)
    if offline:
        return
    for (repo, ref), entries in sources.items():
        with tempfile.TemporaryDirectory() as tmp:
            try:
                subprocess.run(
                    ["git", "clone", "--quiet", "--filter=blob:none", "--no-checkout", repo, tmp],
                    check=True,
                    capture_output=True,
                    timeout=300,
                )
                subprocess.run(
                    ["git", "sparse-checkout", "set", "--no-cone", *[e["path"] for e in entries]],
                    cwd=tmp,
                    check=True,
                    capture_output=True,
                    timeout=60,
                )
                subprocess.run(
                    ["git", "checkout", "--quiet", ref], cwd=tmp, check=True, capture_output=True, timeout=300
                )
            except subprocess.CalledProcessError as error:
                errors.append(f"{repo}@{ref}: {error.stderr.decode().strip()[-200:]}")
                continue
            for entry in entries:
                check_skill(Path(tmp) / entry["path"], errors, f"{entry['name']} ({repo}@{ref})")


agents = set()


def main():
    offline = "--offline" in sys.argv
    errors = []
    if not (ROOT / "AGENTS.md").is_file():
        errors.append("AGENTS.md missing")
    agents.update({"build", "plan", "general", "explore"})
    agents.update(path.stem for path in (ROOT / "opencode/agents").glob("*.md"))
    check_markdown("agent", ROOT / "opencode/agents", errors)
    check_markdown("command", ROOT / "opencode/commands", errors)
    for path in sorted((ROOT / "skills").iterdir()):
        if path.is_dir():
            check_skill(path, errors, f"skills/{path.name}")
    for path in sorted((ROOT / "opencode/plugins").glob("*.ts")):
        if "export default" not in path.read_text():
            errors.append(f"{path.relative_to(ROOT)}: needs a default export {{ id, setup }}")
    check_manifest(errors, offline)
    for error in errors:
        print(f"error: {error}")
    print(f"agent config: {len(errors)} error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
