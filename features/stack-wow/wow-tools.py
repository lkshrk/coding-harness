#!/usr/bin/env python3
"""Offline WoW addon helpers for nightshift workers: wow-api and wow-check share this file."""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote

WOW_HOME = Path(os.environ.get("WOW_HOME", "/var/cache/nightshift/wow"))
CACHE = Path(os.environ.get("WOW_CACHE", WOW_HOME / "cache"))
LUACHECKRC = Path(os.environ.get("WOW_LUACHECKRC", WOW_HOME / "luacheckrc"))
API_DOCS = WOW_HOME / "wow-ui-source/Interface/AddOns/Blizzard_APIDocumentationGenerated"
ANNOTATIONS = WOW_HOME / "wow-api/Annotations"
CURRENT_INTERFACE = int(os.environ.get("WOW_INTERFACE", "120100"))


class LuaParser:
    """Parses the data subset of Lua that SavedVariables and API documentation files use."""

    token_re = re.compile(
        r"""\s+|--\[\[.*?\]\]|--[^\n]*|(?P<str>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?P<long>\[(?P<eq>=*)\[.*?\](?P=eq)\])"""
        r"""|(?P<num>-?0x[0-9a-fA-F]+|-?\d+\.?\d*(?:[eE][-+]?\d+)?)|(?P<name>[A-Za-z_][A-Za-z0-9_.:]*)|(?P<sym>[{}\[\]=,;()])""",
        re.S,
    )

    def __init__(self, text):
        self.tokens = []
        pos = 0
        while pos < len(text):
            m = self.token_re.match(text, pos)
            if not m:
                pos += 1
                continue
            pos = m.end()
            for kind in ("str", "long", "num", "name", "sym"):
                if m.group(kind) is not None:
                    self.tokens.append((kind, m.group(kind)))
                    break
        self.i = 0

    def peek(self, offset=0):
        j = self.i + offset
        return self.tokens[j] if j < len(self.tokens) else (None, None)

    def take(self):
        tok = self.peek()
        self.i += 1
        return tok

    def expect(self, value):
        kind, tok = self.take()
        if tok != value:
            raise ValueError(f"expected {value!r}, got {tok!r}")

    def value(self):
        kind, tok = self.take()
        if kind == "str":
            return unescape(tok[1:-1])
        if kind == "long":
            body = tok[tok.index("[", 1) + 1 : tok.rindex("]", 0, len(tok) - 1)]
            return body[1:] if body.startswith("\n") else body
        if kind == "num":
            return int(tok, 16) if tok.lower().lstrip("-").startswith("0x") else (float(tok) if any(c in tok for c in ".eE") else int(tok))
        if kind == "name":
            return {"true": True, "false": False, "nil": None}.get(tok, tok)
        if tok == "{":
            return self.table()
        raise ValueError(f"unexpected token {tok!r}")

    def table(self):
        items, keyed, index = {}, False, 1
        while self.peek()[1] != "}":
            if self.peek()[0] is None:
                raise ValueError("unterminated Lua table")
            kind, tok = self.peek()
            if tok == "[":
                self.take()
                key = self.value()
                self.expect("]")
                self.expect("=")
                items[key] = self.value()
                keyed = True
            elif kind == "name" and self.peek(1)[1] == "=":
                self.take()
                self.take()
                items[tok] = self.value()
                keyed = True
            else:
                items[index] = self.value()
                index += 1
            if self.peek()[1] in (",", ";"):
                self.take()
        self.expect("}")
        if not keyed or all(isinstance(k, int) for k in items):
            if list(items) == list(range(1, len(items) + 1)):
                return [items[k] for k in range(1, len(items) + 1)]
        return items

    def assignments(self):
        """Top-level `name = value` statements, as SavedVariables files are written."""
        out = {}
        while self.peek()[0] is not None:
            kind, tok = self.take()
            if tok == "local":
                continue
            if kind == "name" and self.peek()[1] == "=":
                self.take()
                out[tok] = self.value()
        return out


ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"', "'": "'", "a": "\a", "b": "\b", "f": "\f", "v": "\v", "\n": "\n"}


def unescape(s):
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c != "\\":
            out.append(c)
            i += 1
            continue
        nxt = s[i + 1 : i + 2]
        if nxt.isdigit():
            digits = re.match(r"\d{1,3}", s[i + 1 :]).group(0)
            out.append(chr(int(digits)))
            i += 1 + len(digits)
        else:
            out.append(ESCAPES.get(nxt, nxt))
            i += 2
    return "".join(out)


# --- wow-api ---------------------------------------------------------------------

def api_index():
    if not API_DOCS.is_dir():
        sys.exit(f"wow-api: {API_DOCS} missing")
    cache = CACHE / "wow-api-index.json"
    stamp = max((p.stat().st_mtime for p in API_DOCS.glob("*.lua")), default=0)
    if not stamp:
        sys.exit(f"wow-api: no API documentation in {API_DOCS}")
    if cache.exists() and cache.stat().st_mtime >= stamp:
        return json.loads(cache.read_text())
    entries = []
    for path in sorted(API_DOCS.glob("*.lua")):
        text = path.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"local\s+\w+\s*=\s*\{", text)
        if not m:
            continue
        parser = LuaParser(text[m.end() - 1 :])
        try:
            system = parser.value()
        except ValueError:
            continue
        if not isinstance(system, dict):
            continue
        ns = system.get("Namespace")
        for fn in system.get("Functions") or []:
            entries.append({"kind": "function", "name": f"{ns}.{fn['Name']}" if ns else fn["Name"], "doc": fn, "file": path.name})
        for ev in system.get("Events") or []:
            entries.append({"kind": "event", "name": ev.get("LiteralName") or ev["Name"], "doc": ev, "file": path.name})
        for tb in system.get("Tables") or []:
            entries.append({"kind": tb.get("Type", "table").lower(), "name": tb["Name"], "doc": tb, "file": path.name})
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(entries))
    return entries


def fmt_params(params):
    out = []
    for p in params or []:
        t = p.get("Type", "?") + ("?" if p.get("Nilable") else "")
        if p.get("InnerType"):
            t += f"<{p['InnerType']}>"
        default = f" = {p['Default']}" if "Default" in p else ""
        out.append(f"{p.get('Name', '?')}: {t}{default}")
    return ", ".join(out)


def cmd_api(args):
    entries = api_index()
    q = args.query.lower()
    exact = [e for e in entries if e["name"].lower() == q or e["name"].lower().endswith("." + q)]
    hits = exact or [e for e in entries if q in e["name"].lower()]
    if args.kind:
        hits = [e for e in hits if e["kind"] == args.kind]
    if not hits:
        print(f"no API entry matches {args.query!r}. It may not exist in the current game version; check {WOW_HOME / 'wow-ui-source'} before using it.")
        return 1
    if args.json:
        print(json.dumps(hits[: args.limit], indent=2))
        return 0
    for e in hits[: args.limit]:
        d = e["doc"]
        if e["kind"] == "function":
            ret = fmt_params(d.get("Returns"))
            print(f"{e['name']}({fmt_params(d.get('Arguments'))})" + (f" -> {ret}" if ret else ""))
        elif e["kind"] == "event":
            print(f"event {e['name']}({fmt_params(d.get('Payload'))})")
        else:
            fields = d.get("Fields") or []
            print(f"{e['kind']} {e['name']} {{ {fmt_params(fields)} }}" if fields else f"{e['kind']} {e['name']}")
        notes = [f"{k}={d[k]}" for k in ("SecretArguments", "SecretReturns", "SecretWhenInCombat", "MayReturnNothing", "IsProtectedFunction") if k in d]
        docs = " ".join(d.get("Documentation") or []) if isinstance(d.get("Documentation"), list) else ""
        if notes or docs:
            print("  " + " ".join(notes + ([docs] if docs else [])))
        print(f"  ({e['file']})")
    if len(hits) > args.limit:
        print(f"... {len(hits) - args.limit} more; refine the query")
    return 0


# --- wow-check -------------------------------------------------------------------

TOC_META = re.compile(r"^##\s*([^:]+):\s*(.*)$")


def find_ci(base, rel):
    """Case-insensitive path resolution: the game runs on Windows, the workspace on Linux."""
    cur = base
    for part in [p for p in rel.replace("\\", "/").split("/") if p and p != "."]:
        if part == "..":
            cur = cur.parent
            continue
        if not cur.is_dir():
            return None
        match = next((c for c in cur.iterdir() if c.name.lower() == part.lower()), None)
        if match is None:
            return None
        cur = match
    return cur


def addon_dirs(paths):
    seen = []
    for root in paths:
        root = Path(root).resolve()
        for toc in sorted(root.rglob("*.toc")):
            rel = toc.relative_to(root).parts
            if any(p.startswith(".") or p.lower() == "libs" for p in rel[:-1]) or len(rel) > 3:
                continue
            if toc.parent not in seen:
                seen.append(toc.parent)
    return seen


def lint_toc(addon, problems, missing_libs):
    for toc in sorted(addon.glob("*.toc")):
        interfaces, files = [], []
        for raw in toc.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            line = raw.strip()
            m = TOC_META.match(line)
            if m:
                if m.group(1).strip().lower() == "interface":
                    interfaces = [int(x) for x in re.findall(r"\d+", m.group(2))]
                continue
            if not line or line.startswith("#"):
                continue
            files.append(re.sub(r"\s*\[[^\]]*\]\s*$", "", line))
        retail = [i for i in interfaces if i >= 100000]
        if not interfaces:
            problems.append(("error", toc, 0, "no ## Interface line"))
        elif retail and max(retail) < CURRENT_INTERFACE:
            problems.append(("warning", toc, 0, f"## Interface {max(retail)} is older than the game ({CURRENT_INTERFACE}); the addon is hidden unless 'Load out of date AddOns' is on"))
        for rel in files:
            if "[" in rel:
                continue
            target = find_ci(addon, rel)
            if target is None:
                if rel.replace("\\", "/").lower().startswith("libs/"):
                    missing_libs.append(rel)
                else:
                    problems.append(("error", toc, 0, f"listed file missing: {rel}"))
            elif target.suffix.lower() == ".xml":
                lint_xml(target, problems)


def lint_xml(xml, problems, seen=None):
    seen = seen if seen is not None else set()
    if xml in seen:
        return
    seen.add(xml)
    text = xml.read_text(encoding="utf-8", errors="replace")
    for m in re.finditer(r"<(Script|Include)\s[^>]*file\s*=\s*\"([^\"]+)\"", text):
        target = find_ci(xml.parent, m.group(2))
        line = text.count("\n", 0, m.start()) + 1
        if target is None:
            problems.append(("error", xml, line, f"{m.group(1)} file missing: {m.group(2)}"))
        elif target.suffix.lower() == ".xml":
            lint_xml(target, problems, seen)


def lua_files(addon):
    return [p for p in sorted(addon.rglob("*.lua")) if not any(part.lower() == "libs" or part.startswith(".") for part in p.relative_to(addon).parts[:-1])]


GLOBAL_DEF = re.compile(r"^(?:function\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(.:]|([A-Za-z_][A-Za-z0-9_]*)\s*=[^=])", re.M)


XML_TAG = re.compile(r"<(/?)([A-Za-z]\w*)\b([^>]*?)(/?)>", re.S)
XML_NAME_ATTR = re.compile(r"\bname\s*=\s*\"([^\"]+)\"")
CAPS_ASSIGN = re.compile(r"^\s+([A-Z][A-Z0-9_]{2,})\s*=[^=]", re.M)
G_ASSIGN = re.compile(r"_G(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*[\"']([A-Za-z_][A-Za-z0-9_]*)[\"']\s*\])\s*=[^=]")
# Set by the client per locale; no UI source file defines them.
ENGINE_GLOBALS = {"STANDARD_TEXT_FONT", "UNIT_NAME_FONT", "DAMAGE_TEXT_FONT", "NAMEPLATE_FONT", "NAMEPLATE_SPELLCAST_FONT"}


def xml_frame_names(text):
    """Named frames in a FrameXML file, with $parent resolved against the nearest named ancestor."""
    names, stack = set(), []
    for m in XML_TAG.finditer(text):
        closing, attrs = m.group(1), m.group(3)
        self_closing = bool(m.group(4)) or attrs.rstrip().endswith("/")
        if closing:
            if stack:
                stack.pop()
            continue
        parent = next((n for n in reversed(stack) if n), "")
        attr = XML_NAME_ATTR.search(attrs)
        name = ""
        if attr:
            name = attr.group(1).replace("$parent", parent).replace("$Parent", parent)
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                names.add(name)
            else:
                name = ""
        if not self_closing:
            stack.append(name)
    return names


def framexml_globals():
    """Constants and frames Blizzard's own UI code defines; complements the generated lists in the default config."""
    root = WOW_HOME / "wow-ui-source/Interface"
    if not root.is_dir():
        return []
    cache = CACHE / "wow-framexml-globals.json"
    version = WOW_HOME / "wow-ui-source/version.txt"
    stamp = version.stat().st_mtime if version.exists() else 0
    if cache.exists() and cache.stat().st_mtime >= stamp:
        return json.loads(cache.read_text())
    names = set()
    for path in root.rglob("*.lua"):
        text = path.read_text(encoding="utf-8", errors="replace")
        for m in GLOBAL_DEF.finditer(text):
            names.add(m.group(1) or m.group(2))
        names.update(CAPS_ASSIGN.findall(text))
        for m in G_ASSIGN.finditer(text):
            names.add(m.group(1) or m.group(2))
    for path in root.rglob("*.xml"):
        names.update(xml_frame_names(path.read_text(encoding="utf-8", errors="replace")))
    names.update(ENGINE_GLOBALS)
    names.discard("local")
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(sorted(names)))
    return sorted(names)


def luacheck_set_globals(roots, base_cfg):
    """Globals the repository itself assigns, as luacheck reports them (W111/W112)."""
    if not shutil.which("luacheck"):
        return set()
    files = [str(p) for r in roots for p in Path(r).rglob("*.lua") if not any(part.startswith(".") for part in p.relative_to(r).parts)]
    names = set()
    for i in range(0, len(files), 400):
        res = subprocess.run(["luacheck", "--formatter", "plain", "--codes", "--no-color", "--config", str(base_cfg), "--only", "111", "112", "--", *files[i : i + 400]], capture_output=True, text=True)
        if res.returncode not in (0, 1, 2):
            raise RuntimeError(f"luacheck global discovery failed ({res.returncode}): {(res.stderr or res.stdout).strip()[-300:]}")
        names.update(re.findall(r"\(W11[12]\) (?:setting|mutating) non-standard global variable '([^']+)'", res.stdout))
    return names


def repo_globals(roots):
    names = set()
    for root in roots:
        root = Path(root).resolve()
        for toc in root.rglob("*.toc"):
            for line in toc.read_text(encoding="utf-8-sig", errors="replace").splitlines():
                m = re.match(r"^##\s*SavedVariables(?:PerCharacter)?:\s*(.*)$", line.strip())
                if m:
                    names.update(v.strip() for v in m.group(1).split(",") if v.strip())
        for lua in root.rglob("*.lua"):
            if any(part.startswith(".") for part in lua.relative_to(root).parts):
                continue
            text = lua.read_text(encoding="utf-8", errors="replace")
            for m in GLOBAL_DEF.finditer(text):
                names.add(m.group(1) or m.group(2))
            for m in G_ASSIGN.finditer(text):
                names.add(m.group(1) or m.group(2))
        for xml in root.rglob("*.xml"):
            if not any(part.startswith(".") for part in xml.relative_to(root).parts):
                names.update(xml_frame_names(xml.read_text(encoding="utf-8", errors="replace")))
    names.discard("local")
    return sorted(names)


UNUSED_CODES = ("122", "211", "212", "213", "231", "311", "421", "431", "432", "542", "631")
LUALS_DEFAULT = {"deprecated", "missing-parameter", "redundant-parameter", "param-type-mismatch", "undefined-field", "unbalanced-assignments", "missing-return", "return-type-mismatch", "duplicate-set-field", "undefined-doc-name"}


def luacheck_config(roots, tmp):
    read = set()
    if LUACHECKRC.exists():
        read.update(LuaParser(LUACHECKRC.read_text()).assignments().get("read_globals") or [])
    read.update(framexml_globals())
    lua = lambda names: "{" + ",".join(json.dumps(n) for n in sorted(names)) + "}"
    cfg = Path(tmp) / "luacheckrc"
    writable = set(repo_globals(roots)) | {"_G"}
    write = lambda extra: cfg.write_text(f"std = \"lua51\"\nmax_line_length = false\nread_globals = {lua(read)}\nglobals = {lua(writable | extra)}\n")
    write(set())
    write(luacheck_set_globals(roots, cfg))
    return cfg


def run_luacheck(addon, problems, notes, config, pedantic):
    if not shutil.which("luacheck"):
        problems.append(("error", addon, 0, "luacheck not installed"))
        return
    files = lua_files(addon)
    if not files:
        return
    own = next((p / ".luacheckrc" for p in [addon, *addon.parents] if (p / ".luacheckrc").exists()), None)
    cmd = ["luacheck", "--formatter", "plain", "--codes", "--no-color"]
    cmd += ["--config", str(own)] if own else ["--config", str(config)]
    res = subprocess.run([*cmd, *map(str, files)], capture_output=True, text=True, cwd=addon)
    if res.returncode not in (0, 1, 2):
        problems.append(("error", addon, 0, f"luacheck failed ({res.returncode}): {(res.stderr or res.stdout).strip()[-300:]}"))
        return
    parsed = False
    for line in res.stdout.splitlines():
        m = re.match(r"(.+?):(\d+):\d+: \((\w)(\d+)\) (.*)", line)
        if not m:
            continue
        parsed = True
        if not pedantic and m.group(4) in UNUSED_CODES:
            continue
        sev = "error" if m.group(3) == "E" else "warning"
        problems.append((sev, Path(m.group(1)), int(m.group(2)), f"luacheck {m.group(3)}{m.group(4)}: {m.group(5)}"))
    if res.returncode and not parsed:
        problems.append(("error", addon, 0, f"luacheck failed without diagnostics ({res.returncode}): {(res.stderr or res.stdout).strip()[-300:]}"))


def run_luals(addon, problems, notes, pedantic):
    exe = shutil.which("lua-language-server")
    if not exe:
        problems.append(("error", addon, 0, "lua-language-server not installed"))
        return
    if not ANNOTATIONS.is_dir():
        problems.append(("error", addon, 0, f"{ANNOTATIONS} missing"))
        return
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Path(tmp) / "luarc.json"
        cfg.write_text(json.dumps({
            "runtime.version": "Lua 5.1",
            "runtime.builtin": {k: "disable" for k in ("basic", "debug", "io", "math", "os", "package", "string", "table", "utf8")},
            "workspace.library": [str(ANNOTATIONS)],
            "workspace.checkThirdParty": False,
            "workspace.ignoreDir": ["Libs", "libs", ".git"],
            "diagnostics.disable": ["undefined-global", "lowercase-global"],
        }))
        repo_cfg = addon / ".luarc.json"
        cfg_path = repo_cfg if repo_cfg.exists() else cfg
        try:
            res = subprocess.run(
                [exe, f"--check={addon}", "--checklevel=Warning", "--check_format=json", f"--logpath={tmp}", f"--configpath={cfg_path}"],
                capture_output=True, text=True, timeout=1800,
            )
        except subprocess.TimeoutExpired:
            problems.append(("error", addon, 0, "lua-language-server timed out"))
            return
        report = Path(tmp) / "check.json"
        if not report.exists():
            if res.returncode == 0:
                return
            problems.append(("error", addon, 0, f"lua-language-server failed: {(res.stderr or res.stdout).strip()[-300:]}"))
            return
        try:
            diagnostics = luals_report(report.read_text())
        except (ValueError, TypeError) as exc:
            problems.append(("error", addon, 0, f"invalid lua-language-server report: {exc}"))
            return
        if res.returncode not in (0, 1) or (res.returncode and not any(diagnostics.values())):
            problems.append(("error", addon, 0, f"lua-language-server failed ({res.returncode}): {(res.stderr or res.stdout).strip()[-300:]}"))
            return
        for uri, diags in diagnostics.items():
            path = Path(unquote(uri.replace("file://", "")))
            if any(p.lower() == "libs" for p in path.parts):
                continue
            source = None
            for d in diags:
                if not pedantic and d.get("code") not in LUALS_DEFAULT:
                    continue
                if source is None:
                    source = path.read_text(errors="replace").splitlines() if path.is_file() else []
                sev = "error" if d.get("severity") == 1 else "warning"
                line = d.get("range", {}).get("start", {}).get("line", 0) + 1
                msg = d.get("message", "").splitlines()[0]
                snippet = range_text(source, d.get("range", {}))
                if snippet and snippet not in msg:
                    msg = f"{msg} `{snippet}`"
                problems.append((sev, path, line, f"luals {d.get('code')}: {msg}"))


# lua-language-server writes [] instead of {} when nothing was found.
def luals_report(text):
    data = json.loads(text) if text.strip() else {}
    if data == []:
        return {}
    if not isinstance(data, dict) or any(not isinstance(v, list) for v in data.values()):
        raise ValueError("expected diagnostic map or empty array")
    return data


def range_text(lines, rng):
    start, end = rng.get("start", {}), rng.get("end", {})
    row = start.get("line")
    if row is None or row != end.get("line") or row >= len(lines):
        return ""
    text = lines[row][start.get("character", 0):end.get("character", 0)].strip()
    return text if 0 < len(text) <= 80 and re.search(r"\w", text) else ""


def cmd_check(args):
    paths = args.paths or ["."]
    addons = addon_dirs(paths)
    if not addons:
        print(f"no addon (.toc) found under {', '.join(paths)}")
        return 1
    roots = sorted({str(Path(p).resolve()) for p in paths} | {repo_root(a) for a in addons})
    failed = False
    with tempfile.TemporaryDirectory() as tmp:
        config = luacheck_config(roots, tmp) if not args.no_lua else None
        for addon in addons:
            problems, notes, counts = [], [], {}
            missing_libs = []
            lint_toc(addon, problems, missing_libs)
            counts["toc/xml"] = len(problems)
            if missing_libs:
                notes.append(f"{len(missing_libs)} Libs file(s) listed in the .toc are absent from the checkout (packager externals?): {', '.join(missing_libs[:4])}{' ...' if len(missing_libs) > 4 else ''}")
            if not args.no_lua:
                before = len(problems)
                run_luacheck(addon, problems, notes, config, args.pedantic)
                counts["luacheck"] = len(problems) - before
                if not args.fast:
                    before = len(problems)
                    run_luals(addon, problems, notes, args.pedantic)
                    counts["luals"] = len(problems) - before
            errors = [p for p in problems if p[0] == "error"]
            warnings = [p for p in problems if p[0] == "warning"]
            failed = failed or bool(errors)
            per_tool = ", ".join(f"{k} {v}" for k, v in counts.items())
            print(f"== {addon.name}: {len(errors)} error(s), {len(warnings)} warning(s) [{per_tool}]")
            for sev, path, line, msg in (errors + warnings)[: args.limit]:
                rel = path.relative_to(addon) if path.is_absolute() and addon in path.parents else path
                print(f"  {sev[0].upper()} {rel}{':' + str(line) if line else ''} {msg}")
            if len(problems) > args.limit:
                print(f"  ... {len(problems) - args.limit} more (--limit)")
            for n in notes:
                print(f"  note: {n}")
    return 1 if failed else 0


def repo_root(addon):
    res = subprocess.run(["git", "-C", str(addon), "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    return res.stdout.strip() if res.returncode == 0 and res.stdout.strip() else str(addon)


def main():
    prog = Path(sys.argv[0]).name
    argv = sys.argv[1:]
    commands = {"wow-api": "api", "wow-check": "check"}
    if prog in commands:
        argv = [commands[prog], *argv]

    ap = argparse.ArgumentParser(prog="wow-tools")
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("api", help="look up a WoW API function, event or table in Blizzard's generated documentation")
    a.add_argument("query")
    a.add_argument("--kind", choices=["function", "event", "structure", "enumeration", "constants", "table"])
    a.add_argument("--limit", type=int, default=15)
    a.add_argument("--json", action="store_true")
    a.set_defaults(func=cmd_api)

    c = sub.add_parser("check", help="lint addons: .toc/XML references, luacheck, lua-language-server")
    c.add_argument("paths", nargs="*")
    c.add_argument("--fast", action="store_true", help="skip lua-language-server")
    c.add_argument("--no-lua", action="store_true", help="only .toc and XML checks")
    c.add_argument("--limit", type=int, default=60)
    c.add_argument("--pedantic", action="store_true", help="also report unused variables and arguments")
    c.set_defaults(func=cmd_check)

    args = ap.parse_args(argv)
    try:
        return args.func(args)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"{prog}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
