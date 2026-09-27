from __future__ import annotations

import os
import re
import shlex
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from .config import Task

WORKDIR = "/work"
BASE_REF = "harness-base"
HOME = "/home/agent"


@dataclass
class ExecResult:
    exit_code: int
    stdout: str
    stderr: str
    duration_s: float
    timed_out: bool = False


class Sandbox:
    """Disposable container per run: only the run's clone and its own HOME are mounted."""

    def __init__(self, run_dir: Path, task: Task):
        self.run_dir = run_dir
        self.task = task
        self.repo = run_dir / "repo"
        self.source = run_dir / "source"
        self.home = run_dir / "home"
        self.container: str | None = None

    def prepare(self) -> None:
        # The agent repo holds base and its ancestors only: later commits would contain the reference fix.
        self.home.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "git",
                "-c",
                "core.hooksPath=/dev/null",
                "clone",
                "--quiet",
                "--no-checkout",
                "--template=",
                self.task.repo,
                str(self.source),
            ],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(self.source), "config", "uploadpack.allowAnySHA1InWant", "true"], check=True
        )
        git = ["git", "-C", str(self.repo)]
        subprocess.run(["git", "init", "--quiet", "--template=", str(self.repo)], check=True)
        subprocess.run([*git, "config", "core.hooksPath", "/dev/null"], check=True)
        subprocess.run([*git, "config", "user.name", "coding-harness"], check=True)
        subprocess.run([*git, "config", "user.email", "harness@localhost"], check=True)
        subprocess.run([*git, "fetch", "--quiet", "--no-tags", str(self.source), self.task.base], check=True)
        subprocess.run([*git, "checkout", "--quiet", "--detach", "FETCH_HEAD"], check=True)
        subprocess.run([*git, "tag", BASE_REF], check=True)

    def export(self, commit: str, dest: Path) -> None:
        """Write the tree of a source commit into dest without touching its git metadata."""
        with tempfile.NamedTemporaryFile(dir=self.run_dir) as index:
            env = {**os.environ, "GIT_INDEX_FILE": index.name}
            git = ["git", f"--git-dir={self.source / '.git'}", f"--work-tree={dest}"]
            subprocess.run([*git, "read-tree", commit], check=True, env=env)
            subprocess.run([*git, "checkout-index", "--all", "--force"], check=True, env=env)

    def show_source(self, commit: str, path: str) -> bytes | None:
        res = subprocess.run(
            ["git", "-C", str(self.source), "show", f"{commit}:{path}"], capture_output=True, check=False
        )
        return res.stdout if res.returncode == 0 else None

    def start(self) -> None:
        image = f"coding-harness:{self.task.toolchain}"
        cmd = [
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            f"harness-{self.run_dir.name}"[:63],
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            "-v",
            f"{self.repo}:{WORKDIR}",
            "-v",
            f"{self.home}:{HOME}",
            "-w",
            WORKDIR,
        ]
        for key, value in self.task.env.items():
            cmd += ["-e", f"{key}={value}"]
        ca = os.environ.get("EXTRA_CA_CERT")
        if ca:
            cmd += ["-v", f"{ca}:/etc/harness/ca.pem:ro", "-e", "NODE_EXTRA_CA_CERTS=/etc/harness/ca.pem"]
        cmd += [image, "sleep", "infinity"]
        self.container = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.strip()

    def exec(
        self,
        argv: list[str],
        env: dict[str, str] | None = None,
        timeout: int = 3600,
        stdin: str | None = None,
    ) -> ExecResult:
        assert self.container, "sandbox not started"
        cmd = ["docker", "exec", *(["-i"] if stdin is not None else []), "-w", WORKDIR]
        for key, value in (env or {}).items():
            cmd += ["-e", f"{key}={value}"]
        cmd += [self.container, *argv]
        start = time.monotonic()
        try:
            proc = subprocess.run(
                cmd, input=stdin, capture_output=True, text=True, timeout=timeout, check=False
            )
        except subprocess.TimeoutExpired as exc:
            return ExecResult(
                124, _text(exc.stdout), _text(exc.stderr), time.monotonic() - start, timed_out=True
            )
        return ExecResult(proc.returncode, proc.stdout, proc.stderr, time.monotonic() - start)

    def sh(self, script: str, timeout: int = 1800, stdin: str | None = None) -> ExecResult:
        # Not a login shell: Debian's /etc/profile would reset PATH and drop toolchain dirs like /usr/local/go/bin.
        return self.exec(["bash", "-c", script], timeout=timeout, stdin=stdin)

    def run_setup(self) -> None:
        for command in self.task.setup:
            res = self.sh(command, timeout=3600)
            if res.exit_code != 0:
                raise RuntimeError(f"task setup failed: {command}\n{(res.stdout + res.stderr)[-2000:]}")

    def apply_patch(self, patch: str, reset_files_to_base: bool = False) -> None:
        if reset_files_to_base:
            files = sorted(set(re.findall(r"^diff --git a/(\S+) b/", patch, re.MULTILINE)))
            existing = [
                f for f in files if self.sh(f"git cat-file -e {BASE_REF}:{shlex.quote(f)}").exit_code == 0
            ]
            if existing:
                self.sh(f"git checkout {BASE_REF} -- " + " ".join(shlex.quote(f) for f in existing))
        res = self.sh("git apply --whitespace=nowarn -", stdin=patch)
        if res.exit_code != 0:
            raise RuntimeError(f"git apply failed: {res.stderr.strip()[:500]}")

    def diff(self) -> str:
        self.sh("git add --intent-to-add --all")
        return self.sh(f"git diff {BASE_REF}").stdout

    def restore_hidden_tests(self) -> None:
        if self.task.hidden_test_patch:
            self.apply_patch(self.task.hidden_test_patch, reset_files_to_base=True)
        elif self.task.reference and self.task.hidden_tests:
            for path in self.task.hidden_tests:
                content = self.show_source(self.task.reference, path)
                if content is None:
                    raise RuntimeError(f"restoring hidden tests failed: {path} not in {self.task.reference}")
                target = self.repo / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)

    def checkout_reference(self) -> None:
        """Replace the working tree with the reference commit's tree."""
        self.sh(f"git checkout --quiet --force {BASE_REF} && git clean -fdq")
        tracked = self.sh("git ls-files -z").stdout.split("\0")
        for path in filter(None, tracked):
            (self.repo / path).unlink(missing_ok=True)
        assert self.task.reference
        self.export(self.task.reference, self.repo)

    def stop(self) -> None:
        if self.container:
            subprocess.run(["docker", "rm", "-f", self.container], capture_output=True, check=False)
            self.container = None


def _text(value: bytes | str | None) -> str:
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    return value or ""
