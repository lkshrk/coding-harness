import type { AttachInfo } from '@nightshift/supervisor'
import { type Ctx, EXIT, parseArgs, requireArg } from '../cli'
import { call } from './shared'

export const ATTACH_USAGE = 'ns attach <target> [--full] [--shell] [--in-sandbox]'

export function hostTui(info: AttachInfo, full = false): { cmd: string[]; env: Record<string, string> } {
  return {
    cmd: ['opencode', ...(full ? [] : ['mini']), '--server', info.url, '--session', info.session],
    env: { OPENCODE_PASSWORD: info.password },
  }
}

export async function attachInfo(ctx: Ctx, target: string): Promise<AttachInfo> {
  return call<AttachInfo>(ctx, 'GET', `/runs/${encodeURIComponent(target)}/attach`)
}

export async function attach(ctx: Ctx, args: string[]): Promise<number> {
  const { positionals, bools } = parseArgs(
    args,
    { bools: ['--full', '--shell', '--in-sandbox'] },
    ATTACH_USAGE,
  )
  const target = requireArg(positionals[0], ATTACH_USAGE)
  const info = await attachInfo(ctx, target)
  if (bools.has('--shell')) return ctx.exec(info.shell)
  if (bools.has('--in-sandbox') || ctx.which('opencode') === null) {
    if (!bools.has('--in-sandbox'))
      ctx.io.err('opencode is not installed on this host; attaching inside the sandbox')
    return ctx.exec(info.fallback)
  }
  const tui = hostTui(info, bools.has('--full'))
  const code = await ctx.exec(tui.cmd, { env: tui.env })
  return code === 0 ? EXIT.ok : code
}
