import { watch as fsWatch } from 'node:fs'
import { basename, dirname } from 'node:path'
import { DEFAULTS_PATH, type LoadResult, loadConfig, userConfigPath } from '@nightshift/core'

export { changedPaths, restartRequired } from '../policy/config'

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
