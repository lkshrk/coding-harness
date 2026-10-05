import { watch as fsWatch } from 'node:fs'
import { basename, dirname } from 'node:path'
import { DEFAULTS_PATH, type LoadResult, loadConfig, userConfigPath } from '@nightshift/core'

const RESTART_PATHS = ['paths', 'sandbox.driver', 'notifications.signal']

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function changedPaths(a: unknown, b: unknown, prefix = ''): string[] {
  if (isMap(a) && isMap(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    return keys.flatMap((k) => changedPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k)).sort()
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix]
}

export function restartRequired(changed: readonly string[]): boolean {
  return changed.some((p) => RESTART_PATHS.some((r) => p === r || p.startsWith(`${r}.`)))
}

export type WatchOptions = {
  files?: string[]
  load?: () => LoadResult
  watch?: (file: string, onEvent: () => void) => () => void
  schedule?: (fn: () => void) => () => void
}

function watchFile(file: string, onEvent: () => void): () => void {
  const watcher = fsWatch(dirname(file), (_event, name) => {
    if (name === basename(file)) onEvent()
  })
  return () => watcher.close()
}

function debounce(fn: () => void): () => void {
  const timer = setTimeout(fn, 250)
  return () => clearTimeout(timer)
}

export function watchConfig(onChange: (r: LoadResult) => void, opts: WatchOptions = {}): () => void {
  const files = opts.files ?? [userConfigPath(process.env), DEFAULTS_PATH]
  const load = opts.load ?? (() => loadConfig())
  const watch = opts.watch ?? watchFile
  const schedule = opts.schedule ?? debounce
  let cancel: (() => void) | undefined
  const fire = () => {
    cancel?.()
    cancel = schedule(() => {
      cancel = undefined
      onChange(load())
    })
  }
  const stops = files.map((f) => watch(f, fire))
  return () => {
    cancel?.()
    for (const stop of stops) stop()
  }
}
