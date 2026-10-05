import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { userConfigPath } from '../config/loader'

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

export function credentialsDir(env: Record<string, string | undefined>): string {
  return join(dirname(userConfigPath(env)), 'credentials')
}

export function credentialNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => ENV_NAME.test(name) && statSync(join(dir, name)).isFile())
      .sort()
  } catch {
    return []
  }
}

// Each file is one value, named after the env: reference that reads it; a trailing newline is dropped.
export function credentialEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of credentialNames(dir)) {
    const value = readFileSync(join(dir, name), 'utf8').replace(/\r?\n$/, '')
    if (value) env[name] = value
  }
  return env
}

export function withCredentials(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...credentialEnv(credentialsDir(env)), ...env }
}
