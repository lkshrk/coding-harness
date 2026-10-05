import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [settingsPath, out] = process.argv.slice(2)

// Same file name as the inlang SDK's plugin cache: 64-bit FNV-1a of the module URL in base 36.
function cacheName(url) {
  let hash = 14695981039346656037n
  for (const byte of new TextEncoder().encode(url))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n)
  return hash.toString(36)
}

const modules = JSON.parse(readFileSync(settingsPath, 'utf8')).modules ?? []
mkdirSync(out, { recursive: true })
for (const url of modules) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  writeFileSync(join(out, cacheName(url)), await res.text())
  process.stdout.write(`cached ${url}\n`)
}
