import { expect, test } from 'bun:test'
import { join } from 'node:path'

const helper = join(import.meta.dir, 'wow-tools.py')
const setup = `
import argparse, contextlib, importlib.util, io, json, subprocess, sys, tempfile
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("wow_tools", sys.argv[1])
wow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wow)
temporary = tempfile.TemporaryDirectory()
root = Path(temporary.name)
wow.CACHE = root / "cache"
wow.API_DOCS = root / "docs"
wow.ANNOTATIONS = root / "annotations"
wow.API_DOCS.mkdir()
wow.ANNOTATIONS.mkdir()
addon = root / "Addon"
addon.mkdir()
(addon / "Addon.toc").write_text("## Interface: 120100\\nCore.lua\\n")
(addon / "Core.lua").write_text("return 1\\n")
problems, notes = [], []
`

test.each([
  [
    'Lua parser rejects unterminated tables',
    `
for text in ('{', '{ Name = "Test",', '{ Functions = { { Name = "Get" } }'):
    try:
        wow.LuaParser(text).value()
    except ValueError:
        pass
    else:
        raise AssertionError(f"accepted unterminated table: {text}")
assert wow.LuaParser('{ Name = "Test", Values = {1, 2} }').value() == {"Name": "Test", "Values": [1, 2]}
`,
  ],
  [
    'API lookup reads local documentation and reports missing names',
    `
(wow.API_DOCS / "TestDocumentation.lua").write_text('''local Test = {
    Namespace = "C_Test",
    Functions = {{ Name = "GetValue", Returns = {{ Name = "value", Type = "number" }} }},
    Events = {{ Name = "Changed", LiteralName = "TEST_CHANGED" }},
}''')
args = argparse.Namespace(query="getvalue", kind=None, json=True, limit=15)
with contextlib.redirect_stdout(io.StringIO()) as output:
    assert wow.cmd_api(args) == 0
assert json.loads(output.getvalue())[0]["name"] == "C_Test.GetValue"
assert (wow.CACHE / "wow-api-index.json").is_file()
args.query = "DOES_NOT_EXIST"
with contextlib.redirect_stdout(io.StringIO()):
    assert wow.cmd_api(args) == 1
`,
  ],
  [
    'TOC resolves case-insensitive files and fails missing references',
    `
(addon / "Addon.toc").write_text("## Interface: 120100\\ncore.lua\\nMissing.lua\\nFrames.xml\\n")
(addon / "Frames.xml").write_text('<Ui><Script file="MissingXml.lua"/></Ui>')
wow.lint_toc(addon, problems, [])
assert len(problems) == 2, problems
assert all(p[0] == "error" for p in problems)
assert any("Missing.lua" in p[3] for p in problems)
assert any("MissingXml.lua" in p[3] for p in problems)
args = argparse.Namespace(paths=[str(addon)], no_lua=True, fast=False, pedantic=False, limit=60)
with patch.object(wow, "repo_root", return_value=str(addon)), contextlib.redirect_stdout(io.StringIO()):
    assert wow.cmd_check(args) == 1
`,
  ],
  [
    'global discovery separates warning filters from file operands',
    `
def checked(cmd, **kwargs):
    assert cmd[cmd.index("--only") + 1:] == ["111", "112", "--", str(addon / "Core.lua")], cmd
    return subprocess.CompletedProcess(cmd, 1, "Core.lua:1:1: (W111) setting non-standard global variable 'DemoGlobal'", "")
with patch.object(wow.shutil, "which", return_value="luacheck"), patch.object(wow.subprocess, "run", side_effect=checked):
    assert wow.luacheck_set_globals([addon], root / "luacheckrc") == {"DemoGlobal"}
`,
  ],
  [
    'baked API and FrameXML indexes work without cache writes',
    `
(wow.API_DOCS / "TestDocumentation.lua").write_text('local Test = { Functions = {{ Name = "GetValue" }} }')
wow.WOW_HOME = root
interface = root / "wow-ui-source/Interface"
interface.mkdir(parents=True)
(interface / "Frames.xml").write_text('<Ui><Frame name="Demo"><Frame name="$parentChild"/></Frame></Ui>')
(interface / "Globals.lua").write_text('DEMO_VALUE = 1\\n_G["DemoAssigned"] = {}\\n')
api = wow.api_index()
frames = wow.framexml_globals()
assert {"Demo", "DemoChild", "DEMO_VALUE", "DemoAssigned", "STANDARD_TEXT_FONT"} <= set(frames), frames
with patch.object(Path, "write_text", side_effect=PermissionError("read-only cache")):
    assert wow.api_index() == api
    assert wow.framexml_globals() == frames
`,
  ],
  [
    'missing luacheck and language server are errors',
    `
with patch.object(wow.shutil, "which", return_value=None):
    wow.run_luacheck(addon, problems, notes, root / "luacheckrc", False)
    wow.run_luals(addon, problems, notes, False)
assert len(problems) == 2, problems
assert all(p[0] == "error" and "not installed" in p[3] for p in problems)
`,
  ],
  [
    'luacheck process failures cannot pass silently',
    `
for code in (2, 3):
    problems.clear()
    result = subprocess.CompletedProcess([], code, "", "broken checker")
    with patch.object(wow.shutil, "which", return_value="luacheck"), patch.object(wow.subprocess, "run", return_value=result):
        wow.run_luacheck(addon, problems, notes, root / "luacheckrc", False)
    assert any(p[0] == "error" for p in problems), (code, problems)
`,
  ],
  [
    'language server process failures cannot pass with an empty report',
    `
for create_report in (False, True):
    problems.clear()
    def failed(cmd, **kwargs):
        if create_report:
            log = Path(next(a.split("=", 1)[1] for a in cmd if a.startswith("--logpath=")))
            (log / "check.json").write_text("[]")
        return subprocess.CompletedProcess(cmd, 2, "", "broken language server")
    with patch.object(wow.shutil, "which", return_value="lua-language-server"), patch.object(wow.subprocess, "run", side_effect=failed):
        wow.run_luals(addon, problems, notes, False)
    assert any(p[0] == "error" for p in problems), (create_report, problems)
`,
  ],
  [
    'language server timeout is an error',
    `
with patch.object(wow.shutil, "which", return_value="lua-language-server"), patch.object(wow.subprocess, "run", side_effect=subprocess.TimeoutExpired("lua-language-server", 1800)):
    wow.run_luals(addon, problems, notes, False)
assert any(p[0] == "error" and "timed out" in p[3] for p in problems), problems
`,
  ],
])('offline WoW helper: %s', (_name, code) => {
  const result = Bun.spawnSync(['python3', '-c', setup + code, helper], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
})
