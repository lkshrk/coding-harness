import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import type { Config } from '@nightshift/core'
import { parseDuration } from '../../policy/naming'
import type { GateRunner, LinearPort } from '../../ports'
import { commentUrl } from '../../state/records'

export type ScreenshotConfig = NonNullable<Config['repositories'][string]['screenshots']>

export type ScreenshotDeps = {
  gates: GateRunner
  image: (repository: string) => Promise<string>
  linear: Pick<LinearPort, 'uploadFile' | 'comment' | 'workspace'>
  dir: string
}

export type ScreenshotInput = {
  issue: string
  run: string
  repository: string
  gitDir: string
  base: string
  head: string
  config: ScreenshotConfig | undefined
}

export type ScreenshotOutcome = { url: string; omitted: number } | { reason: string }

type Shot = { page: string; viewport: string; theme: string; file: string }

type Pair = { key: Shot; before: string | null; after: string | null }

export const SCREENSHOT_MARKER = '<!-- nightshift:screenshots -->'

export async function captureScreenshots(d: ScreenshotDeps, i: ScreenshotInput): Promise<ScreenshotOutcome> {
  if (!i.config) return { reason: 'the repository has no screenshots command' }
  const work = join(d.dir, i.run)
  rmSync(work, { recursive: true, force: true })
  try {
    const before = await shoot(d, i, i.config, 'before', i.base, join(work, 'before'))
    if ('reason' in before) return before
    const after = await shoot(d, i, i.config, 'after', i.head, join(work, 'after'))
    if ('reason' in after) return after
    if (before.shots.length === 0 && after.shots.length === 0)
      return { reason: 'the screenshots command produced no images' }
    if (before.shots.length === 0)
      return { reason: 'the screenshots command produced no images on the base commit' }
    if (after.shots.length === 0)
      return { reason: 'the screenshots command produced no images on the head commit' }
    const { pairs, omitted } = capped(pairsOf(before.shots, after.shots), work, i.config)
    if (pairs.length === 0)
      return {
        reason: `the screenshots exceed the cap of ${i.config.max_images} images and ${i.config.max_mb} MB`,
      }
    const urls = new Map<string, string>()
    for (const p of pairs)
      for (const [side, file] of [
        ['before', p.before],
        ['after', p.after],
      ] as const) {
        if (file === null) continue
        const bytes = new Uint8Array(readFileSync(join(work, side, file)))
        urls.set(`${side}/${file}`, await d.linear.uploadFile(uploadName(p.key, side), 'image/png', bytes))
      }
    const comment = await d.linear.comment(i.issue, commentBody(pairs, urls, omitted), { replace: true })
    const org = (await d.linear.workspace()).organization.urlKey
    return { url: commentUrl(org, i.issue, comment.id) ?? `comment ${comment.id}`, omitted }
  } catch (e) {
    return { reason: `screenshots failed: ${(e as Error).message}` }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function shoot(
  d: ScreenshotDeps,
  i: ScreenshotInput,
  config: ScreenshotConfig,
  side: 'before' | 'after',
  sha: string,
  into: string,
): Promise<{ shots: Shot[] } | { reason: string }> {
  mkdirSync(join(into, '..'), { recursive: true })
  const [result] = await d.gates.run(
    { name: i.repository, image: await d.image(i.repository), gitDir: i.gitDir },
    '',
    sha,
    [{ name: `screenshots-${side}`, run: config.run, timeoutMs: parseDuration(config.timeout) }],
    { run: i.run, collect: { dir: config.output, into } },
  )
  const where = side === 'before' ? 'the base commit' : 'the head commit'
  if (!result?.passed)
    return {
      reason: `the screenshots command failed on ${where} (${result?.result.timedOut ? 'timed out' : `exit ${result?.result.exitCode}`})`,
    }
  const manifest = join(into, 'manifest.json')
  if (!existsSync(manifest)) return { reason: `no manifest.json in ${config.output} on ${where}` }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch {
    return { reason: `${config.output}/manifest.json on ${where} is not valid JSON` }
  }
  if (!Array.isArray(parsed)) return { reason: `${config.output}/manifest.json on ${where} is not a list` }
  const shots = parsed.filter(isShot).filter((s) => existsSync(join(into, s.file)))
  return { shots }
}

function isShot(v: unknown): v is Shot {
  if (v === null || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  const text = (k: string) => typeof s[k] === 'string' && (s[k] as string).length > 0
  if (!(text('page') && text('viewport') && text('theme') && text('file'))) return false
  const file = normalize(s.file as string)
  return !isAbsolute(file) && !file.startsWith('..') && file.toLowerCase().endsWith('.png')
}

const keyOf = (s: Shot) => `${s.page}\u0000${s.viewport}\u0000${s.theme}`

function pairsOf(before: Shot[], after: Shot[]): Pair[] {
  const pairs = new Map<string, Pair>()
  for (const s of after)
    if (!pairs.has(keyOf(s))) pairs.set(keyOf(s), { key: s, before: null, after: s.file })
  for (const s of before) {
    const p = pairs.get(keyOf(s))
    if (!p) pairs.set(keyOf(s), { key: s, before: s.file, after: null })
    else if (p.before === null) p.before = s.file
  }
  return [...pairs.values()]
}

function capped(pairs: Pair[], work: string, config: ScreenshotConfig): { pairs: Pair[]; omitted: number } {
  const maxBytes = config.max_mb * 1024 * 1024
  const kept: Pair[] = []
  let images = 0
  let bytes = 0
  for (const p of pairs) {
    const files = [
      p.before && join(work, 'before', p.before),
      p.after && join(work, 'after', p.after),
    ].filter((f): f is string => Boolean(f))
    const size = files.reduce((n, f) => n + statSync(f).size, 0)
    if (images + files.length > config.max_images || bytes + size > maxBytes) break
    kept.push(p)
    images += files.length
    bytes += size
  }
  return { pairs: kept, omitted: pairs.length - kept.length }
}

function uploadName(s: Shot, side: string): string {
  const slug = `${s.page}-${s.viewport}-${s.theme}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${slug || 'page'}-${side}.png`
}

function commentBody(pairs: Pair[], urls: Map<string, string>, omitted: number): string {
  const cell = (side: 'before' | 'after', file: string | null) => {
    const url = file === null ? undefined : urls.get(`${side}/${file}`)
    return url ? `![${side}](${url})` : side === 'before' ? '(new page)' : '(removed page)'
  }
  const lines = [
    '## Screenshots',
    '',
    '| Page | Viewport | Theme | Before | After |',
    '| --- | --- | --- | --- | --- |',
    ...pairs.map(
      (p) =>
        `| \`${p.key.page}\` | ${p.key.viewport} | ${p.key.theme} | ${cell('before', p.before)} | ${cell('after', p.after)} |`,
    ),
  ]
  if (omitted > 0) lines.push('', `${omitted} more screenshots were left out by the configured cap.`)
  lines.push('', SCREENSHOT_MARKER)
  return lines.join('\n')
}
