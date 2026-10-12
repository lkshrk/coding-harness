import type { Capture } from './cli'

export const DETACH_HINT = 'detach: ctrl+c twice, or type /exit and press Enter'

// opencode mini ignores ctrl+c/ctrl+d sent as CSI-u or modifyOtherKeys, which tmux sends with extended-keys on.
export async function withPlainKeys<T>(
  env: Record<string, string | undefined>,
  capture: Capture,
  fn: () => Promise<T>,
): Promise<T> {
  if (!env.TMUX) return fn()
  const shown = capture(['tmux', 'show-options', '-sv', 'extended-keys'])
  const previous = shown.exitCode === 0 ? shown.stdout.trim() : ''
  if (previous === '' || previous === 'off') return fn()
  if (capture(['tmux', 'set-option', '-s', 'extended-keys', 'off']).exitCode !== 0) return fn()
  try {
    return await fn()
  } finally {
    capture(['tmux', 'set-option', '-s', 'extended-keys', previous])
  }
}
