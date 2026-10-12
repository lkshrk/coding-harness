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

export type ScreenshotOutcome = { url: string; reduced: string[]; dropped: string[] } | { reason: string }

type Shot = { page: string; viewport: string; theme: string; file: string }

type PageEntry = { route: string; path: string; new: boolean }

type Capture = { pages: PageEntry[]; shots: Shot[] }

type Status = 'pair' | 'new' | 'removed'

type Pair = { key: Shot; status: Status; before: string | null; after: string | null }

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
    if (after.shots.length === 0)
      return {
        reason: before.shots.length
          ? 'the screenshots command produced no images on the head commit'
          : 'the screenshots command produced no images',
      }
    const matched = pagesOf(before, after)
    if ('reason' in matched) return matched
    const { pairs, reduced, dropped } = capped(
      pairsOf(before.shots, after.shots, matched.status),
      work,
      i.config,
    )
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
    const body = commentBody(pairs, urls, reduced, dropped)
    const comment = await d.linear.comment(i.issue, body, { replace: true })
    const org = (await d.linear.workspace()).organization.urlKey
    return { url: commentUrl(org, i.issue, comment.id) ?? `comment ${comment.id}`, reduced, dropped }
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
): Promise<Capture | { reason: string }> {
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
  const listed = `${config.output}/manifest.json on ${where}`
  const m = parsed as { pages?: unknown; images?: unknown } | null
  if (m === null || typeof m !== 'object' || !Array.isArray(m.pages) || !Array.isArray(m.images))
    return { reason: `${listed} needs a pages list and an images list` }
  const pages: PageEntry[] = []
  for (const [n, entry] of m.pages.entries()) {
    if (!isPage(entry)) return { reason: `${listed} has an invalid page ${n + 1} (needs route and path)` }
    pages.push({ route: entry.route, path: entry.path, new: entry.new === true })
  }
  const routes = new Set(pages.map((p) => p.route))
  for (const [n, entry] of m.images.entries()) {
    if (!isShot(entry))
      return {
        reason: `${listed} has an invalid image ${n + 1} (needs page, viewport, theme and a relative .png file)`,
      }
    if (!routes.has(entry.page))
      return { reason: `${listed} has an image of \`${entry.page}\`, which its pages do not list` }
    if (!existsSync(join(into, entry.file)))
      return { reason: `${listed} lists ${entry.file}, which the command did not write` }
    if (!isPng(join(into, entry.file)))
      return { reason: `${listed} lists ${entry.file}, which is not a readable PNG image` }
  }
  return { pages, shots: m.images as Shot[] }
}

function isPage(v: unknown): v is { route: string; path: string; new?: unknown } {
  if (v === null || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return (
    typeof p.route === 'string' &&
    p.route.length > 0 &&
    typeof p.path === 'string' &&
    p.path.length > 0 &&
    (p.new === undefined || typeof p.new === 'boolean')
  )
}

// Which pages exist is the command's report; a failed or manifest-less capture is already refused in shoot.
function pagesOf(before: Capture, after: Capture): { status: Map<string, Status> } | { reason: string } {
  const was = new Set(before.pages.map((p) => p.route))
  const is = new Set(after.pages.map((p) => p.route))
  const combos = (c: Capture, route: string) =>
    new Set(c.shots.filter((s) => s.page === route).map((s) => `${s.viewport} ${s.theme}`))
  const status = new Map<string, Status>()
  const failed: string[] = []
  for (const route of new Set([...is, ...was])) {
    const s: Status = !was.has(route) ? 'new' : !is.has(route) ? 'removed' : 'pair'
    const b = combos(before, route)
    const a = combos(after, route)
    if (s !== 'new' && b.size === 0) failed.push(`\`${route}\` on the base commit`)
    if (s !== 'removed' && a.size === 0) failed.push(`\`${route}\` on the head commit`)
    if (s === 'pair' && b.size && a.size)
      for (const combo of new Set([...a, ...b]))
        if (!a.has(combo) || !b.has(combo))
          failed.push(`\`${route}\` ${combo} on the ${a.has(combo) ? 'base' : 'head'} commit`)
    status.set(route, s)
  }
  if (failed.length) return { reason: `the screenshots command missed images: ${failed.join(', ')}` }
  return { status }
}

function isShot(v: unknown): v is Shot {
  if (v === null || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  const text = (k: string) => typeof s[k] === 'string' && (s[k] as string).length > 0
  if (!(text('page') && text('viewport') && text('theme') && text('file'))) return false
  const file = normalize(s.file as string)
  return !isAbsolute(file) && !file.startsWith('..') && file.toLowerCase().endsWith('.png')
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

function isPng(path: string): boolean {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return false
  }
  return (
    bytes.length > 33 &&
    PNG_SIGNATURE.every((b, n) => bytes[n] === b) &&
    bytes.subarray(12, 16).toString('latin1') === 'IHDR'
  )
}

const keyOf = (s: Shot) => `${s.page}\u0000${s.viewport}\u0000${s.theme}`

function pairsOf(before: Shot[], after: Shot[], status: Map<string, Status>): Pair[] {
  const pairs = new Map<string, Pair>()
  const statusOf = (s: Shot) => status.get(s.page) ?? 'pair'
  for (const s of after)
    if (!pairs.has(keyOf(s)))
      pairs.set(keyOf(s), { key: s, status: statusOf(s), before: null, after: s.file })
  for (const s of before) {
    const p = pairs.get(keyOf(s))
    if (!p) pairs.set(keyOf(s), { key: s, status: statusOf(s), before: s.file, after: null })
    else if (p.before === null) p.before = s.file
  }
  return [...pairs.values()]
}

// Over the cap: every page keeps only phone and desktop in light mode; if still over, whole pages are kept in order.
function capped(
  all: Pair[],
  work: string,
  config: ScreenshotConfig,
): { pairs: Pair[]; reduced: string[]; dropped: string[] } {
  const cost = (pairs: Pair[]) => {
    const files = pairs.flatMap((p) => [
      ...(p.before === null ? [] : [join(work, 'before', p.before)]),
      ...(p.after === null ? [] : [join(work, 'after', p.after)]),
    ])
    return { images: files.length, bytes: files.reduce((n, f) => n + statSync(f).size, 0) }
  }
  const fits = (pairs: Pair[]) => {
    const c = cost(pairs)
    return c.images <= config.max_images && c.bytes <= config.max_mb * 1024 * 1024
  }
  if (fits(all)) return { pairs: all, reduced: [], dropped: [] }
  const pages = [...new Set(all.map((p) => p.key.page))]
  const small = all.filter((p) => REDUCED_VIEWPORTS.has(p.key.viewport) && p.key.theme === REDUCED_THEME)
  const reduced = pages.filter((page) => all.some((p) => p.key.page === page && !small.includes(p)))
  const kept: Pair[] = []
  const keptPages: string[] = []
  for (const page of pages) {
    const own = small.filter((p) => p.key.page === page)
    if (own.length === 0) continue
    if (!fits([...kept, ...own])) break
    kept.push(...own)
    keptPages.push(page)
  }
  return {
    pairs: kept,
    reduced: reduced.filter((page) => keptPages.includes(page)),
    dropped: pages.filter((page) => !keptPages.includes(page)),
  }
}

const REDUCED_VIEWPORTS = new Set(['phone', 'desktop'])
const REDUCED_THEME = 'light'

function uploadName(s: Shot, side: string): string {
  const slug = `${s.page}-${s.viewport}-${s.theme}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${slug || 'page'}-${side}.png`
}

function commentBody(pairs: Pair[], urls: Map<string, string>, reduced: string[], dropped: string[]): string {
  const cell = (p: Pair, side: 'before' | 'after') => {
    const file = p[side]
    const url = file === null ? undefined : urls.get(`${side}/${file}`)
    if (url) return `![${side}](${url})`
    return p.status === 'new' ? '(new page)' : p.status === 'removed' ? '(removed page)' : '(not captured)'
  }
  const lines = [
    '## Screenshots',
    '',
    '| Page | Viewport | Theme | Before | After |',
    '| --- | --- | --- | --- | --- |',
    ...pairs.map(
      (p) =>
        `| \`${p.key.page}\` | ${p.key.viewport} | ${p.key.theme} | ${cell(p, 'before')} | ${cell(p, 'after')} |`,
    ),
  ]
  lines.push(...capNotes(reduced, dropped), '', SCREENSHOT_MARKER)
  return lines.join('\n')
}

export function capNotes(reduced: readonly string[], dropped: readonly string[]): string[] {
  return [
    ...(reduced.length
      ? ['', 'Reduced to phone and desktop in light mode (image cap):', ...reduced.map((p) => `- \`${p}\``)]
      : []),
    ...(dropped.length ? ['', 'Left out (image cap):', ...dropped.map((p) => `- \`${p}\``)] : []),
  ]
}
