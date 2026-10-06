export type Word = { value: string; dynamic: boolean; glob?: boolean }

export class ParseError extends Error {}

export class Unresolved extends ParseError {}

export function tokenize(command: string): Word[][] {
  const segments: Word[][] = [[]]
  let word: Word | null = null
  let skipNext = false
  let i = 0
  const at = (k = 0) => command[i + k] ?? ''
  const push = (ch: string) => {
    word ??= { value: '', dynamic: false }
    word.value += ch
  }
  const end = () => {
    if (word === null) return
    if (skipNext) skipNext = false
    else segments.at(-1)?.push(word)
    word = null
  }
  const split = () => {
    end()
    if (skipNext) throw new ParseError('redirection without target')
    if ((segments.at(-1)?.length ?? 0) > 0) segments.push([])
  }
  const dollar = () => {
    const next = at(1)
    if (next === '(') throw new ParseError('command substitution')
    if (/[A-Za-z_{0-9?@*#!$'"-]/.test(next)) {
      push('$')
      if (word) word.dynamic = true
    } else push('$')
    i++
  }

  while (i < command.length) {
    const ch = at()
    if (ch === '\\') {
      if (at(1) === '\n') i += 2
      else {
        push(at(1))
        i += 2
      }
    } else if (ch === "'") {
      const close = command.indexOf("'", i + 1)
      if (close < 0) throw new ParseError('unterminated quote')
      push(command.slice(i + 1, close))
      i = close + 1
    } else if (ch === '"') {
      push('')
      i++
      for (;;) {
        const c = at()
        if (c === '') throw new ParseError('unterminated quote')
        if (c === '"') {
          i++
          break
        }
        if (c === '`') throw new ParseError('command substitution')
        if (c === '$') dollar()
        else if (c === '\\' && /["\\$`\n]/.test(at(1))) {
          if (at(1) !== '\n') push(at(1))
          i += 2
        } else {
          push(c)
          i++
        }
      }
    } else if (ch === '`' || ch === '(' || ch === ')') {
      throw new ParseError('subshell')
    } else if (ch === '$') {
      dollar()
    } else if (ch === '#' && word === null) {
      while (i < command.length && at() !== '\n') i++
    } else if (ch === '>' || ch === '<' || (ch === '&' && at(1) === '>')) {
      const current = word as Word | null
      if (current && /^\d+$/.test(current.value)) word = null
      end()
      let op = ''
      while (/[<>&|]/.test(at()) && op.length < 3) {
        op += at()
        i++
      }
      if (at() === '(') throw new ParseError('process substitution')
      if (op.endsWith('&') && /[\d-]/.test(at())) {
        while (/[\d-]/.test(at())) i++
      } else skipNext = true
    } else if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      split()
      i++
      while (/[|&;]/.test(at())) i++
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      end()
      i++
    } else {
      push(ch)
      const current = word as Word | null
      if (current && /[*?[]/.test(ch)) current.glob = true
      i++
    }
  }
  split()
  return segments.filter((s) => s.length > 0)
}
