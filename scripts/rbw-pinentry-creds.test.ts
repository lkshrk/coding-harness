import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = join(import.meta.dir, 'rbw-pinentry-creds')
const dir = mkdtempSync(join(tmpdir(), 'ns-pinentry-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const fake = join(dir, 'systemd-creds')
writeFileSync(fake, '#!/usr/bin/env bash\n[ -f "$4" ] || exit 1\ncat "$4"\n')
chmodSync(fake, 0o755)

function pinentry(input: string, cred: string): string {
  const res = Bun.spawnSync(['bash', script], {
    stdin: new TextEncoder().encode(input),
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, NIGHTSHIFT_RBW_CRED: cred },
  })
  return res.stdout.toString()
}

test('answers the master password prompt percent-encoded and declines other prompts', () => {
  const cred = join(dir, 'rbw.cred')
  writeFileSync(cred, 'p%w\nx')
  const out = pinentry(
    'SETTITLE rbw\nSETPROMPT Master Password\nGETPIN\nSETPROMPT API key\nGETPIN\nBYE\n',
    cred,
  )
  expect(out.split('\n')).toEqual([
    'OK Pleased to meet you',
    'OK',
    'OK',
    'D p%25w%0Ax',
    'OK',
    'OK',
    'ERR 83886179 Operation cancelled',
    'OK',
    '',
  ])
})

test('cancels when the credential cannot be decrypted', () => {
  const out = pinentry('SETPROMPT Master Password\nGETPIN\n', join(dir, 'missing.cred'))
  expect(out).toEndWith('ERR 83886179 Operation cancelled\n')
  expect(out).not.toContain('D ')
})
