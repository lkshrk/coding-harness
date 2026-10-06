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
