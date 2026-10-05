#!/usr/bin/env bash
set -euo pipefail

# Run the built image with --network=none; all data below must already be baked in.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export HOME="$work/home"
mkdir -p "$HOME"
test -s "${WOW_HOME:?}/pins.sh"
test -s "${WOW_CACHE:?}/wow-api-index.json"
test -s "$WOW_CACHE/wow-framexml-globals.json"
test -d "$WOW_HOME/wow-api/Annotations"
test -s "${WOW_LUACHECKRC:?}"
mkdir -p "$work/Demo" "$work/tests"
printf '## Interface: %s\n## Title: Demo\n## SavedVariables: DemoDB\nDemo.lua\n' "${WOW_INTERFACE:?}" >"$work/Demo/Demo.toc"
cat >"$work/Demo/Demo.lua" <<'LUA'
DemoDB = DemoDB or {}
local frame = CreateFrame("Frame", "DemoFrame", UIParent)
frame:RegisterEvent("PLAYER_LOGIN")
frame:SetScript("OnEvent", function()
  local _, name = C_PetJournal.GetPetInfoByPetID("BattlePet-0-000000000000")
  DemoDB.last = name or GetTime()
end)
function Demo_Add(a, b)
  return a + b
end
LUA
cat >"$work/tests/add_test.lua" <<'LUA'
local root = ... or "."
CreateFrame = function() return { RegisterEvent = function() end, SetScript = function() end } end
dofile(root .. "/Demo/Demo.lua")
assert(Demo_Add(2, 3) == 5, "Demo_Add")
assert(setfenv and not table.unpack, "Lua 5.1 semantics expected")
print("add_test ok")
LUA

lsp_initialize() {
  python3 - "$work" "$@" <<'PY'
import json, subprocess, sys, threading
from pathlib import Path
root, cmd = sys.argv[1], sys.argv[2:]
child = subprocess.Popen(cmd, cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
timer = threading.Timer(60, lambda: (print(f"{' '.join(cmd)}: LSP lifecycle timed out", file=sys.stderr), child.kill()))
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
    assert child.wait(timeout=10) == 0, "language server did not exit cleanly"
finally:
    timer.cancel()
    if child.poll() is None:
        child.kill()
        child.wait()
PY
}

lua -e 'assert(_VERSION == "Lua 5.1", _VERSION)'
lua5.1 -e 'assert(_VERSION == "Lua 5.1" and setfenv and not table.unpack)'
lua -v
luacheck --version | head -n 1
lua-language-server --version
python3 --version

lsp_initialize lua-language-server --configpath="$WOW_HOME/luarc.json"

(cd "$work" && luacheck --no-color --config "$WOW_LUACHECKRC" --globals DemoDB Demo_Add DemoFrame -- Demo)
(cd "$work" && wow-check Demo)
(cd "$work" && for t in tests/*_test.lua; do lua5.1 "$t" . || exit 1; done)

wow-api C_PetJournal.GetPetInfoTableByPetID | tee "$work/api.txt"
grep -q '^C_PetJournal.GetPetInfoTableByPetID(petID: WOWGUID)' "$work/api.txt"
grep -rqF 'C_PetJournal.GetPetInfoByPetID(' "$WOW_HOME/wow-ui-source/Interface/AddOns"
wow-api PET_JOURNAL_LIST_UPDATE --kind event | grep -q '^event PET_JOURNAL_LIST_UPDATE'
if wow-api NIGHTSHIFT_NONEXISTENT_API >"$work/missing-api.txt"; then
  echo "wow-api accepted a nonexistent API" >&2
  exit 1
fi
grep -q 'no API entry matches' "$work/missing-api.txt"

printf 'Missing.lua\n' >>"$work/Demo/Demo.toc"
printf 'DemoDB = UndefinedThing.field\n' >"$work/Demo/Demo.lua"
if (cd "$work" && wow-check --fast Demo >"$work/bad.txt"); then
  cat "$work/bad.txt"
  echo "wow-check passed an addon whose .toc lists a missing file" >&2
  exit 1
fi
grep -q 'listed file missing: Missing.lua' "$work/bad.txt"
grep -q "W113: accessing undefined variable 'UndefinedThing'" "$work/bad.txt"
echo "wow-check flags missing files and undefined globals"
