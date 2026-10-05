#!/usr/bin/env bash
set -euo pipefail

# Run the built image with --network=none; everything below must already be baked in.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export HOME="$work/home"
mkdir -p "$HOME" "$work/demo/demo"
test -d "${UV_CACHE_DIR:?}"
test -w "$UV_CACHE_DIR"
test -d "${UV_PYTHON_INSTALL_DIR:?}"

cat >"$work/demo/pyproject.toml" <<'TOML'
[project]
name = "demo"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = []
TOML
printf 'def add(a: int, b: int) -> int:\n    return a + b\n' >"$work/demo/demo/__init__.py"

lsp_initialize() {
  python3 - "$work/demo" "$@" <<'PY'
import json, subprocess, sys, threading
from pathlib import Path
root, cmd = sys.argv[1], sys.argv[2:]
child = subprocess.Popen(cmd, cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
timer = threading.Timer(30, lambda: (print(f"{' '.join(cmd)}: LSP lifecycle timed out", file=sys.stderr), child.kill()))
timer.daemon = True
timer.start()

def send(msg):
    body = json.dumps({"jsonrpc": "2.0", **msg}).encode()
    child.stdin.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
    child.stdin.flush()

def receive():
    headers = {}
    while (line := child.stdout.readline()) not in (b"\r\n", b""):
        k, _, v = line.decode().partition(":")
        headers[k.strip().lower()] = v.strip()
    if not headers:
        raise RuntimeError("language server closed stdout before responding")
    return json.loads(child.stdout.read(int(headers["content-length"])))

def response(request_id):
    while True:
        msg = receive()
        if msg.get("id") == request_id and "method" not in msg:
            if "error" in msg:
                raise RuntimeError(msg["error"])
            return msg

try:
    send({"id": 1, "method": "initialize", "params": {"processId": None, "rootUri": Path(root).as_uri(), "capabilities": {}, "workspaceFolders": None}})
    assert response(1).get("result", {}).get("capabilities"), "missing LSP capabilities"
    print(f"{' '.join(cmd)}: initialize ok")
    send({"method": "initialized", "params": {}})
    send({"id": 2, "method": "shutdown"})
    response(2)
    send({"method": "exit"})
    child.stdin.close()
    child.wait(timeout=10)
finally:
    timer.cancel()
    if child.poll() is None:
        child.kill()
        child.wait()
PY
}

uv --version
uvx --version
python --version
python3 --version
ruff --version
ty --version

(cd "$work/demo" && ruff check . && ruff format --check .)
(cd "$work/demo" && ty check .)
(cd "$work/demo" && uv lock --offline && uv sync --frozen --offline && uv run --frozen --offline python -c 'import demo; assert demo.add(2, 3) == 5')

printf 'import os\n' >"$work/demo/demo/bad.py"
if (cd "$work/demo" && ruff check . >"$work/ruff.txt"); then
  echo "ruff check passed a file with an unused import" >&2
  exit 1
fi
grep -q F401 "$work/ruff.txt"
rm "$work/demo/demo/bad.py"

lsp_initialize ty server
lsp_initialize ruff server
