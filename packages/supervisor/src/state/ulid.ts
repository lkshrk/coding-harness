const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RANDOM_CHARS = 16

function encodeTime(ms: number): string {
  let out = ''
  let rest = ms
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[rest % 32] + out
    rest = Math.floor(rest / 32)
  }
  return out
}

function randomDigits(): number[] {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_CHARS))
  return Array.from(bytes, (b) => b % 32)
}

function increment(digits: number[]): number[] {
  const out = [...digits]
  for (let i = out.length - 1; i >= 0; i--) {
    if ((out[i] ?? 0) < 31) {
      out[i] = (out[i] ?? 0) + 1
      return out
    }
    out[i] = 0
  }
  throw new Error('ulid: random component overflow')
}

export function createUlid(now: () => number = Date.now): () => string {
  let lastTime = -1
  let lastRandom: number[] = []
  return () => {
    const t = Math.max(now(), lastTime)
    lastRandom = t === lastTime ? increment(lastRandom) : randomDigits()
    lastTime = t
    return encodeTime(t) + lastRandom.map((d) => ALPHABET[d]).join('')
  }
}

export function ulidTime(id: string): number {
  return [...id.slice(0, 10)].reduce((acc, ch) => acc * 32 + ALPHABET.indexOf(ch), 0)
}
