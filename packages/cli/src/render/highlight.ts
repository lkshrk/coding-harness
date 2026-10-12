import { createHighlighterCoreSync, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import css from 'shiki/langs/css.mjs'
import diff from 'shiki/langs/diff.mjs'
import go from 'shiki/langs/go.mjs'
import javascript from 'shiki/langs/javascript.mjs'
import json from 'shiki/langs/json.mjs'
import python from 'shiki/langs/python.mjs'
import rust from 'shiki/langs/rust.mjs'
import shellscript from 'shiki/langs/shellscript.mjs'
import sql from 'shiki/langs/sql.mjs'
import toml from 'shiki/langs/toml.mjs'
import tsx from 'shiki/langs/tsx.mjs'
import typescript from 'shiki/langs/typescript.mjs'
import yaml from 'shiki/langs/yaml.mjs'
import tokyoNight from 'shiki/themes/tokyo-night.mjs'

const THEME = 'tokyo-night'

let highlighter: HighlighterCore | undefined

function load(): HighlighterCore {
  highlighter ??= createHighlighterCoreSync({
    themes: [tokyoNight],
    langs: [css, diff, go, javascript, json, python, rust, shellscript, sql, toml, tsx, typescript, yaml],
    engine: createJavaScriptRegexEngine(),
  })
  return highlighter
}

function truecolor(hex: string): string {
  const n = Number.parseInt(hex.slice(1, 7), 16)
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
}

export function highlight(code: string, lang?: string): string {
  if (!lang) return code
  const h = load()
  const id = lang.toLowerCase()
  if (!h.getLoadedLanguages().includes(id)) return code
  const lines = h.codeToTokensBase(code, { lang: id, theme: THEME })
  return lines
    .map((tokens) =>
      tokens.map((t) => (t.color ? `${truecolor(t.color)}${t.content}\x1b[39m` : t.content)).join(''),
    )
    .join('\n')
}
