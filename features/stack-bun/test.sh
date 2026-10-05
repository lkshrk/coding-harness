#!/usr/bin/env bash
set -euo pipefail

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf '{"compilerOptions":{"strict":true}}\n' >"$work/tsconfig.json"
printf 'export const answer: number = 42\n' >"$work/index.ts"

lsp_initialize() {
  node --input-type=module - "$work" "$@" <<'EOF'
import { spawn } from 'node:child_process'
const [root, ...cmd] = process.argv.slice(2)
const child = spawn(cmd[0], cmd.slice(1), { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] })
const send = (msg) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...msg })
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
const timer = setTimeout(() => {
  console.error(`${cmd.join(' ')}: no initialize response`)
  child.kill('SIGKILL')
  process.exit(1)
}, 30_000)
let buf = Buffer.alloc(0)
child.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const end = buf.indexOf('\r\n\r\n')
    if (end < 0) return
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString())?.[1])
    if (buf.length < end + 4 + len) return
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString())
    buf = buf.subarray(end + 4 + len)
    if (msg.id === 1 && msg.result?.capabilities) {
      clearTimeout(timer)
      console.log(`${cmd.join(' ')}: initialize ok`)
      send({ id: 2, method: 'shutdown' })
      send({ method: 'exit' })
      setTimeout(() => {
        child.kill('SIGKILL')
        process.exit(0)
      }, 500)
    }
  }
})
child.on('exit', (code) => {
  if (code !== 0 && code !== null) console.error(`${cmd.join(' ')}: exited ${code}`)
})
send({
  id: 1,
  method: 'initialize',
  params: { processId: process.pid, rootUri: `file://${root}`, capabilities: {}, workspaceFolders: null },
})
EOF
}

bun --version
typescript-language-server --version
biome --version
oxlint --version

lsp_initialize typescript-language-server --stdio
lsp_initialize biome lsp-proxy
