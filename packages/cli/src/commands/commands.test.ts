import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Config, outputValidator } from '@nightshift/core'
import {
  createUlid,
  type Db,
  EventLog,
  type EventType,
  openState,
  RunStore,
  setCovered,
} from '@nightshift/supervisor'
import { createCtx } from '../cli'
import { ControlFailure, type ControlFn } from '../client'
import { type CliDeps, run } from '../run'
import { Tmux, type TmuxRunner } from '../tmux'
import { syncPanes } from './watch'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const NOW = Date.parse('2026-10-04T10:10:00.000Z')

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-cmd-'))
  dirs.push(dir)
  const dbPath = join(dir, 'state.db')
  const db = openState(dbPath)
  let t = Date.parse('2026-10-04T10:00:00.000Z')
  const now = () => new Date(t)
  const ulid = createUlid(() => t)
  const runs = new RunStore(db, { now, ulid })
  const log = new EventLog(db, { now, ulid })
  const tick = (ms = 1000) => {
    t += ms
  }
  const config = {
    paths: { state: dir, cache: dir, vault: dir },
    repositories: { omni: { path: join(dir, 'omni') } },
  } as unknown as Config
  const deps: CliDeps = {
    statePath: () => dbPath,
    socketPath: () => join(dir, 'nightshift.sock'),
    load: () => ({ ok: true, config, sources: [] }),
    now: () => new Date(NOW),
    stdoutIsTTY: false,
    env: {},
  }
  return { dir, dbPath, db, runs, log, tick, deps }
}

function addRun(s: ReturnType<typeof seeded>, issue: string, state: 'running' | 'done' = 'running') {
  const r = s.runs.create({
    issue,
    agent: 'implementer',
    profile: 'default',
    model: 'qwen-coder',
    repository: 'omni',
    baseSha: '',
    attempt: 1,
  })
  const cause = s.log.append({
    type: 'DISPATCHED',
    issue,
    run: r.id,
    data: { agent: 'implementer', profile: 'default', model: 'qwen-coder', attempt: 1, repository: 'omni' },
  })
  s.runs.transition(r.id, 'starting', cause)
  s.runs.transition(r.id, 'running', cause)
  if (state === 'done') {
    s.runs.transition(r.id, 'gating', cause)
    s.runs.transition(r.id, 'reviewing', cause)
    s.runs.transition(r.id, 'done', cause)
  }
  return r
}

function insertIssue(
  db: Db,
  identifier: string,
  stage: string,
  lifecycle: string,
  over: Record<string, unknown> = {},
) {
  db.query(
    `INSERT INTO issues (identifier, title, project, stage, lifecycle, status, blockers, waiting, updated_at)
     VALUES ($identifier, $title, 'Omni', $stage, $lifecycle, 'Todo', $blockers, $waiting, '2026-10-04T09:00:00.000Z')`,
  ).run({
    identifier,
    title: `issue ${identifier}`,
    stage,
    lifecycle,
    blockers: '[]',
    waiting: null,
    ...over,
  } as Record<string, string | null>)
}

async function cli(args: string[], deps: CliDeps) {
  const out: string[] = []
  const err: string[] = []
  const code = await run(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, deps)
  return { code, out, err }
}

const ANSI = new RegExp(String.fromCharCode(27))

describe('common rules', () => {
  test('usage errors exit 2', async () => {
    const s = seeded()
    expect((await cli(['pause', 'not-an-issue'], s.deps)).code).toBe(2)
    expect((await cli(['logs', 'XXX-1', 'XXX-2'], s.deps)).code).toBe(2)
    expect((await cli(['workers', '--frob'], s.deps)).code).toBe(2)
    expect((await cli(['logs', '--type', 'NOPE'], s.deps)).err).toEqual(['unknown event type NOPE'])
  })

  test('control commands exit 3 when the supervisor is not running', async () => {
    const s = seeded()
    const r = await cli(['pause'], s.deps)
    expect(r).toEqual({ code: 3, out: [], err: ['supervisor not running (nightshift up)'] })
  })

  test('colour follows the TTY, NO_COLOR and --json', async () => {
    const s = seeded()
    setCovered(s.db, 'XXX-1', true)
    const tty = { ...s.deps, stdoutIsTTY: true }
    expect((await cli(['status'], tty)).out.join('\n')).toMatch(ANSI)
    expect((await cli(['status'], { ...tty, env: { NO_COLOR: '1' } })).out.join('\n')).not.toMatch(ANSI)
    expect((await cli(['status', '--no-color'], tty)).out.join('\n')).not.toMatch(ANSI)
    expect((await cli(['status'], s.deps)).out.join('\n')).not.toMatch(ANSI)
    const json = await cli(['status', '--json'], tty)
    expect(json.out.join('\n')).not.toMatch(ANSI)
    expect(JSON.parse(json.out.join('\n'))).toMatchObject({ supervisor: 'down', covered: ['XXX-1'] })
  })

  test('status shows the gateway from /health when the supervisor is up', async () => {
    const s = seeded()
    const control = (async () => ({
      dispatch: 'paused',
      gateway: 'unavailable',
      version: '1',
    })) as ControlFn
    const r = await cli(['status'], { ...s.deps, control })
    expect(r.out[0]).toBe('dispatch: paused  gateway: unavailable')
  })

  test('status shows the stored pause reason next to dispatch', async () => {
    const s = seeded()
    const meta = s.db.query(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    meta.run('dispatch', 'paused')
    meta.run('dispatch_reason', 'gateway unavailable')
    const control = (async () => ({
      dispatch: 'paused',
      gateway: 'unavailable',
      version: '1',
    })) as ControlFn
    const r = await cli(['status'], { ...s.deps, control })
    expect(r.out[0]).toBe('dispatch: paused (gateway unavailable)  gateway: unavailable')
    const json = JSON.parse((await cli(['status', '--json'], { ...s.deps, control })).out.join('\n'))
    expect(json).toMatchObject({ dispatch: 'paused', dispatch_reason: 'gateway unavailable' })
  })

  test("status shows the active profile's effective limits", async () => {
    const s = seeded()
    const config = {
      profiles: {
        active: 'local',
        memory_budget_gb: 64,
        local: { roles: { worker: 'ns/w' }, models: {}, limits: { steps: 60, max_files: 4 } },
      },
      limits: {
        worker: { wall_clock: '45m', tokens: '2M', steps: 200, no_diff_steps: 25, no_diff_tokens: '250k' },
      },
    } as unknown as Config
    const deps = { ...s.deps, load: () => ({ ok: true as const, config, sources: [] }) }
    const r = await cli(['status'], deps)
    expect(r.out).toContain(
      'limits: 45m, 2M tokens, 60 steps, no diff after 25 steps / 250k tokens, max 4 files',
    )
    const json = JSON.parse((await cli(['status', '--json'], deps)).out.join('\n'))
    expect(json.limits).toEqual({
      wall_clock: '45m',
      tokens: '2M',
      steps: 60,
      no_diff_steps: 25,
      no_diff_tokens: '250k',
      max_files: 4,
    })
  })
})

describe('read commands', () => {
  test('tasks --stage --json prints issue records without colour', async () => {
    const s = seeded()
    insertIssue(s.db, 'XXX-42', 'implementation', 'running')
    insertIssue(s.db, 'XXX-43', 'design', 'ready', { waiting: 'awaiting you (after design)' })
    addRun(s, 'XXX-42')
    const r = await cli(['tasks', '--stage', 'implementation', '--json'], { ...s.deps, stdoutIsTTY: true })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).not.toMatch(ANSI)
    const rows = JSON.parse(r.out.join('\n')) as unknown[]
    expect(rows).toEqual([
      {
        identifier: 'XXX-42',
        title: 'issue XXX-42',
        project: 'Omni',
        stage: 'implementation',
        lifecycle: 'running',
        status: 'Todo',
        blockers: [],
        waiting: null,
        agent: 'implementer',
        agent_state: 'running',
        attempt: 1,
        updated_at: '2026-10-04T09:00:00.000Z',
      },
    ])
    const schema = JSON.parse(
      await Bun.file(join(import.meta.dir, '../../../supervisor/schema/records.schema.json')).text(),
    )
    const { $id: _, properties: __, ...rest } = schema
    expect(outputValidator({ ...rest, $ref: '#/$defs/issueRecord' })(rows[0])).toEqual([])
    const text = await cli(['tasks'], s.deps)
    expect(text.out[0]).toMatch(/^ISSUE\s+STAGE\s+STATUS/)
    expect(text.out[2]).toContain('awaiting you (after design)')
  })

  test('workers lists active runs with progress', async () => {
    const s = seeded()
    const r = addRun(s, 'XXX-42')
    s.log.append({
      type: 'WORKER_PROGRESS',
      run: r.id,
      data: { steps: 12, tool_calls: 9, tokens: 4200, last_tool: 'edit' },
    })
    const out = await cli(['workers'], s.deps)
    expect(out.out[0]).toMatch(/^ISSUE\s+AGENT\s+MODEL\s+STATE\s+ELAPSED\s+STEPS\s+TOKENS\s+LAST TOOL$/)
    expect(out.out[1]).toMatch(/^XXX-42\s+implementer\s+qwen-coder\s+running\s+10m00s\s+12\s+4200\s+edit$/)
    const json = JSON.parse((await cli(['workers', '--json'], s.deps)).out.join('\n'))
    expect(json[0]).toMatchObject({ run: r.id, steps: 12, tool_calls: 9, tokens: 4200, last_tool: 'edit' })
  })

  test('logs filters by issue and type', async () => {
    const s = seeded()
    const a = addRun(s, 'XXX-42')
    const b = addRun(s, 'XXX-43')
    const gate = (r: string, issue: string, type: EventType) =>
      s.log.append({ type, issue, run: r, data: { check: 'test', exit_code: 1, duration_ms: 1000 } })
    gate(a.id, 'XXX-42', 'GATE_FAILED')
    gate(a.id, 'XXX-42', 'GATE_PASSED')
    gate(b.id, 'XXX-43', 'GATE_FAILED')
    const r = await cli(['logs', 'XXX-42', '--type', 'GATE_FAILED'], s.deps)
    expect(r.out).toEqual([expect.stringMatching(/ GATE_FAILED test exit 1 \(1s\)$/)])
    expect((await cli(['logs', 'XXX-99'], s.deps)).code).toBe(4)
    const json = await cli(['logs', b.id, '--json'], s.deps)
    expect(json.out.map((l) => JSON.parse(l).type)).toEqual(['DISPATCHED', 'GATE_FAILED'])
  })

  test('logs -f prints events appended while following, prefixed with the issue', async () => {
    const s = seeded()
    const r = addRun(s, 'XXX-42')
    const controller = new AbortController()
    let polls = 0
    const sleep = async () => {
      polls += 1
      s.tick()
      if (polls === 1) {
        s.log.append({ type: 'WORKER_PROGRESS', run: r.id, data: { steps: 1, tool_calls: 1, tokens: 10 } })
      }
      if (polls === 2) s.log.append({ type: 'DISPATCH_PAUSED', data: { reason: 'ns pause', by: 'cli' } })
      if (polls === 3) controller.abort()
    }
    const out = await cli(['logs', '-f'], { ...s.deps, sleep, signal: controller.signal })
    expect(out.code).toBe(0)
    expect(out.out.map((l) => l.slice(9))).toEqual([
      expect.stringMatching(/^XXX-42 +DISPATCHED implementer attempt 1/),
      expect.stringMatching(/^XXX-42 +WORKER_PROGRESS 1 steps/),
      expect.stringMatching(/^- +DISPATCH_PAUSED ns pause \(by cli\)$/),
    ])
  })

  test('questions list the question with its Linear link', async () => {
    const s = seeded()
    const r = addRun(s, 'XXX-42')
    s.db.query("INSERT INTO meta (key, value) VALUES ('linear_org', 'h-cloud')").run()
    s.db
      .query('INSERT INTO questions (comment, issue, run, asked_to, asked_at) VALUES (?, ?, ?, ?, ?)')
      .run('0f1e2d3c-aaaa-bbbb', 'XXX-42', r.id, 'user', '2026-10-04T10:01:00.000Z')
    s.log.append({
      type: 'QUESTION_ASKED',
      issue: 'XXX-42',
      run: r.id,
      data: { to: 'user', question: 'A or B?', comment: '0f1e2d3c-aaaa-bbbb' },
    })
    const out = await cli(['questions'], s.deps)
    expect(out.out).toEqual([
      'XXX-42 asked 2026-10-04T10:01:00.000Z (to user) https://linear.app/h-cloud/issue/XXX-42#comment-0f1e2d3c',
      '  A or B?',
    ])
  })
})

describe('result commands', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return r.stdout.toString().trim()
  }

  test('diff --stat reads refs/nightshift/<run> against the base without touching the checkout', async () => {
    const s = seeded()
    const repo = join(s.dir, 'omni')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'base')
    const base = git(repo, 'rev-parse', 'HEAD')
    const r = addRun(s, 'XXX-42')
    s.db.query('UPDATE runs SET base_sha = ? WHERE id = ?').run(base, r.id)
    expect(await cli(['diff', 'XXX-42', '--stat'], s.deps)).toEqual({
      code: 4,
      out: [],
      err: [`no result yet for ${r.id}`],
    })
    git(repo, 'checkout', '-qb', 'work')
    writeFileSync(join(repo, 'a.ts'), 'one\nTWO\nthree\n')
    writeFileSync(join(repo, 'b.ts'), 'new\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'work')
    git(repo, 'update-ref', `refs/nightshift/${r.id}`, 'HEAD')
    git(repo, 'checkout', '-q', 'main')
    const out = await cli(['diff', 'XXX-42', '--stat'], s.deps)
    expect(out.out).toEqual([
      ' a.ts | +2 -1',
      ' b.ts | +1 -0',
      ' 2 files changed, 3 insertions(+), 1 deletions(-)',
    ])
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    const patch = await cli(['diff', r.id], s.deps)
    expect(patch.out.join('\n').split('\n')[0]).toBe('diff --git a/a.ts b/a.ts')
  })

  test('diff falls back to the diff.patch artifact', async () => {
    const s = seeded()
    const r = addRun(s, 'XXX-42')
    mkdirSync(join(s.dir, 'artifacts', r.id), { recursive: true })
    writeFileSync(
      join(s.dir, 'artifacts', r.id, 'diff.patch'),
      'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,2 @@\n-a\n+b\n+c\n',
    )
    const out = await cli(['diff', 'XXX-42', '--stat', '--json'], s.deps)
    expect(JSON.parse(out.out.join('\n')).files).toEqual([{ path: 'x.ts', added: 2, deleted: 1 }])
  })

  test('tests prints checks with exit code, duration, tail and artifact, then review findings', async () => {
    const s = seeded()
    const r = addRun(s, 'XXX-42')
    expect((await cli(['tests', 'XXX-42'], s.deps)).code).toBe(4)
    s.log.append({
      type: 'GATE_PASSED',
      issue: 'XXX-42',
      run: r.id,
      data: { check: 'lint', exit_code: 0, duration_ms: 3000, output_tail: 'ok\n', artifact: '/a/lint.log' },
    })
    s.log.append({
      type: 'REVIEW_RECEIVED',
      issue: 'XXX-42',
      run: r.id,
      data: {
        verdict: 'fail',
        model: 'glm',
        findings: [
          {
            severity: 'BLOCKER',
            file: 'src/a.ts',
            lines: '3-4',
            message: 'unchecked',
            evidence: 'e',
            category: 'other',
            confidence: 0.9,
          },
        ],
      },
    })
    const out = await cli(['tests', 'XXX-42'], s.deps)
    expect(out.out).toEqual([
      '✓ lint exit 0 (3s) /a/lint.log',
      '    ok',
      'review: fail (glm)',
      '  BLOCKER src/a.ts:3-4 unchecked',
    ])
  })
})

describe('control commands', () => {
  const recording = (result: unknown | Error = { ok: true }) => {
    const calls: unknown[][] = []
    const control = (async (_path: string, method: string, route: string, body?: unknown) => {
      calls.push([method, route, body])
      if (result instanceof Error) throw result
      return result
    }) as ControlFn
    return { calls, control }
  }

  test('send keeps quotes and spaces; unknown targets exit 4', async () => {
    const s = seeded()
    const ok = recording()
    const r = await cli(['send', 'XXX-42', "it's fine, use the helper"], { ...s.deps, control: ok.control })
    expect(r).toEqual({ code: 0, out: ['sent to XXX-42'], err: [] })
    expect(ok.calls).toEqual([['POST', '/send', { target: 'XXX-42', message: "it's fine, use the helper" }]])
    const missing = recording(new ControlFailure(4, 'no active run for XXX-42', 'not_found'))
    expect(await cli(['send', 'XXX-42', 'x'], { ...s.deps, control: missing.control })).toEqual({
      code: 4,
      out: [],
      err: ['no active run for XXX-42'],
    })
  })

  test('implement --with-dependents lists every dependent before covering them; without it covers one', async () => {
    const s = seeded()
    const calls: unknown[][] = []
    const control = (async (_path: string, method: string, route: string, body?: unknown) => {
      calls.push([method, route, body])
      return route === '/dependents'
        ? { issues: ['XXX-1', 'XXX-2', 'XXX-3'], other: [{ issue: 'XXX-4', reason: 'other project' }] }
        : { ok: true }
    }) as ControlFn
    const prompts: string[] = []
    const confirm = async (q: string) => {
      prompts.push(q)
      return true
    }
    const r = await cli(['implement', 'XXX-1', '--with-dependents'], { ...s.deps, control, confirm })
    expect(r).toEqual({
      code: 0,
      out: [
        'XXX-1, XXX-2, XXX-3 are covered; the supervisor picks them up on its next tick\nnot covered (other project): XXX-4',
      ],
      err: [],
    })
    expect(prompts).toEqual([
      'not covered (other project): XXX-4\nLet nightshift implement XXX-1, XXX-2, XXX-3 (XXX-1 and the issues it blocks)? This changes their Linear state.',
    ])
    expect(calls).toEqual([
      ['POST', '/dependents', { issue: 'XXX-1' }],
      ['POST', '/cover', { issue: 'XXX-1', covered: true }],
      ['POST', '/cover', { issue: 'XXX-2', covered: true }],
      ['POST', '/cover', { issue: 'XXX-3', covered: true }],
    ])

    calls.length = 0
    prompts.length = 0
    const one = await cli(['implement', 'XXX-1'], { ...s.deps, control, confirm })
    expect(one.out).toEqual(['XXX-1 is covered; the supervisor picks it up on its next tick'])
    expect(prompts).toEqual(['Let nightshift implement XXX-1? This changes its Linear state.'])
    expect(calls).toEqual([['POST', '/cover', { issue: 'XXX-1', covered: true }]])

    calls.length = 0
    const declined = await cli(['implement', 'XXX-1', '--with-dependents'], {
      ...s.deps,
      control,
      confirm: async () => false,
    })
    expect(declined.code).toBe(1)
    expect(calls).toEqual([['POST', '/dependents', { issue: 'XXX-1' }]])
    expect((await cli(['release', 'XXX-1', '--with-dependents'], { ...s.deps, control })).code).toBe(2)
  })

  test('stop asks unless --yes', async () => {
    const s = seeded()
    const rec = recording({ run: '01J0000000000000000000000B' })
    const declined = await cli(['stop', 'XXX-42'], {
      ...s.deps,
      control: rec.control,
      confirm: async () => false,
    })
    expect(declined.code).toBe(1)
    expect(rec.calls).toEqual([])
    const r = await cli(['stop', 'XXX-42', '--yes', '--reason', 'wrong approach'], {
      ...s.deps,
      control: rec.control,
    })
    expect(r.code).toBe(0)
    expect(rec.calls).toEqual([['POST', '/stop', { target: 'XXX-42', reason: 'wrong approach' }]])
  })

  test('retry passes agent, profile and continue; refusal exits 5', async () => {
    const s = seeded()
    const rec = recording({ run: '01J0000000000000000000000C' })
    await cli(['retry', 'XXX-42', '--profile', 'quality', '--agent=fixer'], {
      ...s.deps,
      control: rec.control,
    })
    await cli(['retry', 'XXX-42', '--continue'], { ...s.deps, control: rec.control })
    await cli(['retry', 'XXX-42', '--force-size'], { ...s.deps, control: rec.control })
    expect(rec.calls).toEqual([
      ['POST', '/retry', { target: 'XXX-42', agent: 'fixer', profile: 'quality' }],
      ['POST', '/retry', { target: 'XXX-42', continue: true }],
      ['POST', '/retry', { target: 'XXX-42', force_size: true }],
    ])
    const refused = recording(new ControlFailure(5, 'XXX-42: stage design has no automatic role', 'refused'))
    expect((await cli(['retry', 'XXX-42'], { ...s.deps, control: refused.control })).code).toBe(5)
  })

  test('ingest posts the issue; bad arguments exit 2 and refusals print one line', async () => {
    const s = seeded()
    const rec = recording({ run: '01J0000000000000000000000D' })
    expect(await cli(['ingest', 'XXX-278'], { ...s.deps, control: rec.control })).toEqual({
      code: 0,
      out: ['started vault ingest run 01J0000000000000000000000D for XXX-278'],
      err: [],
    })
    expect(rec.calls).toEqual([['POST', '/ingest', { issue: 'XXX-278' }]])
    expect((await cli(['ingest'], { ...s.deps, control: rec.control })).code).toBe(2)
    expect((await cli(['ingest', 'xxx-1'], { ...s.deps, control: rec.control })).code).toBe(2)
    expect((await cli(['ingest', 'XXX-1', 'XXX-2'], { ...s.deps, control: rec.control })).code).toBe(2)
    expect(rec.calls).toHaveLength(1)
    const refused = recording(new ControlFailure(5, 'XXX-278: vault ingest already succeeded', 'refused'))
    expect(await cli(['ingest', 'XXX-278'], { ...s.deps, control: refused.control })).toEqual({
      code: 5,
      out: [],
      err: ['XXX-278: vault ingest already succeeded'],
    })
  })

  test('review-miss splits <file>:<lines>, joins the note and prints the written path', async () => {
    const s = seeded()
    const rec = recording({ path: '/cache/eval/reviewer/R1-m1.json' })
    expect(
      await cli(['review-miss', '#7', 'src/a b.ts:10-12', 'leaks', 'the fd', '--repo', 'omni'], {
        ...s.deps,
        control: rec.control,
      }),
    ).toEqual({ code: 0, out: ['/cache/eval/reviewer/R1-m1.json'], err: [] })
    await cli(['review-miss', 'https://github.com/o/r/pull/7', 'x.ts:3', 'n'], {
      ...s.deps,
      control: rec.control,
    })
    expect(rec.calls).toEqual([
      [
        'POST',
        '/review-miss',
        { pr: '7', file: 'src/a b.ts', lines: '10-12', description: 'leaks the fd', repository: 'omni' },
      ],
      [
        'POST',
        '/review-miss',
        { pr: 'https://github.com/o/r/pull/7', file: 'x.ts', lines: '3', description: 'n' },
      ],
    ])
    for (const bad of [
      [],
      ['7'],
      ['7', 'a.ts', 'n'],
      ['7', 'a.ts:x', 'n'],
      ['pr', 'a.ts:1', 'n'],
      ['7', 'a.ts:1'],
    ])
      expect((await cli(['review-miss', ...bad], { ...s.deps, control: rec.control })).code).toBe(2)
    expect(rec.calls).toHaveLength(2)
    const refused = recording(new ControlFailure(5, 'run R1 did not add src/a.ts:20-25', 'refused'))
    expect(
      await cli(['review-miss', '7', 'src/a.ts:20-25', 'n'], { ...s.deps, control: refused.control }),
    ).toEqual({
      code: 5,
      out: [],
      err: ['run R1 did not add src/a.ts:20-25'],
    })
  })

  test('answer and pause per issue', async () => {
    const s = seeded()
    const rec = recording()
    await cli(['answer', 'XXX-42', 'use', 'the', 'runs', 'table'], { ...s.deps, control: rec.control })
    await cli(['pause', 'XXX-42'], { ...s.deps, control: rec.control })
    await cli(['resume'], { ...s.deps, control: rec.control })
    expect(rec.calls).toEqual([
      ['POST', '/answer', { issue: 'XXX-42', text: 'use the runs table' }],
      ['POST', '/pause', { issue: 'XXX-42' }],
      ['POST', '/resume', {}],
    ])
  })
})

describe('attach', () => {
  const info = {
    url: 'http://127.0.0.1:49152',
    password: 'secret-pw',
    session: 'ses_1',
    workdir: '/work/omni',
    fallback: ['docker', 'exec', '-it', 'c1', 'sh', '-c', 'opencode-worker …'],
    shell: ['docker', 'exec', '-it', 'c1', 'bash'],
  }
  const setup = (which: string | null) => {
    const s = seeded()
    const execs: { cmd: string[]; env?: Record<string, string | undefined> }[] = []
    const routes: string[] = []
    const deps: CliDeps = {
      ...s.deps,
      control: (async (_p: string, _m: string, route: string) => {
        routes.push(route)
        return info
      }) as ControlFn,
      exec: async (cmd, o) => {
        execs.push({ cmd, ...(o?.env ? { env: o.env } : {}) })
        return 0
      },
      which: () => which,
    }
    return { deps, execs, routes }
  }

  test('runs the host TUI with the password only in its environment', async () => {
    const t = setup('/usr/local/bin/opencode')
    const r = await cli(['attach', 'XXX-42'], t.deps)
    expect(r).toEqual({ code: 0, out: [], err: ['detach: ctrl+c twice, or type /exit and press Enter'] })
    expect(t.routes).toEqual(['/runs/XXX-42/attach'])
    expect(t.execs).toEqual([
      {
        cmd: ['opencode', 'mini', '--server', 'http://127.0.0.1:49152', '--session', 'ses_1'],
        env: { OPENCODE_PASSWORD: 'secret-pw' },
      },
    ])
  })

  test('falls back to the in-sandbox TUI without opencode on the host; --shell opens bash', async () => {
    const t = setup(null)
    const r = await cli(['attach', 'XXX-42'], t.deps)
    await cli(['attach', 'XXX-42', '--shell'], t.deps)
    expect(t.execs.map((e) => e.cmd)).toEqual([info.fallback, info.shell])
    expect(r.err).toEqual([
      'opencode is not installed on this host; attaching inside the sandbox',
      'detach: ctrl+c twice, or type /exit and press Enter',
    ])
  })

  test('inside tmux turns extended keys off while attached so ctrl+c arrives as 0x03, then restores them', async () => {
    const t = setup('/usr/local/bin/opencode')
    const order: string[][] = []
    const deps: CliDeps = {
      ...t.deps,
      env: { TMUX: '/tmp/tmux-1000/default,1,0' },
      capture: (argv) => {
        order.push(argv)
        return { exitCode: 0, stdout: argv[1] === 'show-options' ? 'on\n' : '', stderr: '' }
      },
      exec: async (cmd) => {
        order.push(cmd)
        return 0
      },
    }
    expect((await cli(['attach', 'XXX-42'], deps)).code).toBe(0)
    expect(order).toEqual([
      ['tmux', 'show-options', '-sv', 'extended-keys'],
      ['tmux', 'set-option', '-s', 'extended-keys', 'off'],
      ['opencode', 'mini', '--server', 'http://127.0.0.1:49152', '--session', 'ses_1'],
      ['tmux', 'set-option', '-s', 'extended-keys', 'on'],
    ])
    order.length = 0
    await cli(['attach', 'XXX-42', '--in-sandbox'], deps)
    expect(order.at(-1)).toEqual(['tmux', 'set-option', '-s', 'extended-keys', 'on'])
    order.length = 0
    expect((await cli(['attach', 'XXX-42'], { ...deps, env: {} })).code).toBe(0)
    expect(order).toEqual([['opencode', 'mini', '--server', 'http://127.0.0.1:49152', '--session', 'ses_1']])
  })

  test('leaves tmux alone when extended keys are already off', async () => {
    const t = setup('/usr/local/bin/opencode')
    const calls: string[][] = []
    const deps: CliDeps = {
      ...t.deps,
      env: { TMUX: '/tmp/tmux-1000/default,1,0' },
      capture: (argv) => {
        calls.push(argv)
        return { exitCode: 0, stdout: 'off\n', stderr: '' }
      },
    }
    await cli(['attach', 'XXX-42'], deps)
    expect(calls).toEqual([['tmux', 'show-options', '-sv', 'extended-keys']])
  })

  test('without an active run exits 4', async () => {
    const s = seeded()
    const control = (async () => {
      throw new ControlFailure(4, 'no active run for XXX-42', 'not_found')
    }) as ControlFn
    expect(await cli(['attach', 'XXX-42'], { ...s.deps, control })).toEqual({
      code: 4,
      out: [],
      err: ['no active run for XXX-42'],
    })
  })
})

describe('tail', () => {
  test('streams lifecycle events of the run and ends when it is terminal', async () => {
    const s = seeded()
    const r = addRun(s, 'XXX-42')
    let polls = 0
    const sleep = async () => {
      await Bun.sleep(5)
      polls += 1
      s.tick()
      if (polls === 1) {
        s.log.append({
          type: 'GATE_PASSED',
          issue: 'XXX-42',
          run: r.id,
          data: { check: 'test', exit_code: 0, duration_ms: 2000 },
        })
        s.log.append({
          type: 'REVIEW_RECEIVED',
          issue: 'XXX-42',
          run: r.id,
          data: { verdict: 'pass', findings: [] },
        })
        const cause = s.log.since(null).at(-1)
        if (!cause) throw new Error('no event')
        const store = new RunStore(s.db, { now: () => new Date(), ulid: createUlid() })
        store.transition(r.id, 'gating', { ...cause })
        store.transition(r.id, 'reviewing', { ...cause })
        store.transition(r.id, 'done', { ...cause })
      }
    }
    const control = (async () => {
      throw new ControlFailure(3, 'supervisor not running (nightshift up)')
    }) as ControlFn
    const out = await cli(['tail', 'XXX-42'], { ...s.deps, sleep, control })
    expect(out.code).toBe(0)
    expect(out.out.map((l) => l.replace(/^\d\d:\d\d:\d\d /, ''))).toEqual([
      expect.stringMatching(/^DISPATCHED implementer/),
      '(live session unavailable: supervisor not running (nightshift up); showing the event log only)',
      'GATE_PASSED test exit 0 (2s)',
      'REVIEW_RECEIVED pass, 0 findings',
      `· run ${r.id} ended (done)`,
    ])
  })

  test('--no-footer follows without drawing the footer or setting a scroll region', async () => {
    const s = seeded()
    addRun(s, 'XXX-42', 'done')
    const stdout = process.stdout as unknown as Record<string, unknown>
    const saved = { isTTY: stdout.isTTY, rows: stdout.rows, columns: stdout.columns, write: stdout.write }
    const written: string[] = []
    Object.assign(stdout, {
      isTTY: true,
      rows: 24,
      columns: 80,
      write: (chunk: string) => {
        written.push(String(chunk))
        return true
      },
    })
    try {
      const plain = await cli(['tail', 'XXX-42', '--no-footer'], s.deps)
      expect(plain.code).toBe(0)
      expect(written).toEqual([])
      await cli(['tail', 'XXX-42'], s.deps)
      expect(written.join('')).toContain('\x1b[1;23r')
    } finally {
      Object.assign(stdout, saved)
    }
  })

  test('an issue without runs exits 4', async () => {
    const s = seeded()
    expect((await cli(['tail', 'XXX-1'], s.deps)).code).toBe(4)
  })
})

describe('status-line', () => {
  test('--tmux --width clips the line to the pane width with an ellipsis', async () => {
    const s = seeded()
    addRun(s, 'XXX-42')
    const visible = (l: string) => l.replace(/#\[[^\]]*\]/g, '').replaceAll('##', '#')
    const full = await cli(['status-line', 'XXX-42', '--tmux'], s.deps)
    expect(visible(full.out[0] ?? '').length).toBeGreaterThan(60)
    const r = await cli(['status-line', 'XXX-42', '--tmux', '--width', '60'], s.deps)
    expect(r.code).toBe(0)
    const text = visible(r.out[0] ?? '')
    expect(text.startsWith('XXX-42 · implementer · ')).toBe(true)
    expect(text.length).toBeLessThanOrEqual(60)
    expect(text.endsWith('…')).toBe(true)
    expect((await cli(['status-line', 'XXX-42', '--width', 'x'], s.deps)).code).toBe(2)
  })
})

describe('watch panes', () => {
  const fakeTmux = (panes: string[]) => {
    const calls: string[][] = []
    const runner: TmuxRunner = (argv) => {
      const args = argv.slice(3)
      calls.push(args)
      if (args[0] === 'list-panes') return { exitCode: 0, stdout: panes.join('\n'), stderr: '' }
      if (args[0] === 'split-window' || args[0] === 'new-window')
        return { exitCode: 0, stdout: '%20\n', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    return { calls, tmux: new Tmux(runner) }
  }
  const ctxAt = (s: ReturnType<typeof seeded>, at: number) =>
    createCtx(
      { out: () => {}, err: () => {} },
      { json: false, noColor: false, yes: false },
      { statePath: () => s.dbPath, self: ['ns'], now: () => new Date(at) },
    )
  const pane = (id: string, run: string, issue: string, title = issue) =>
    `${id}\t@2\t${run}\t${issue}\t${title}\t0`
  const killed = (calls: string[][]) => calls.filter((c) => c[0] === 'kill-pane').map((c) => c[2])

  test('syncPanes closes panes of runs ended more than 60 s ago and keeps recent ones', () => {
    const s = seeded()
    const old = addRun(s, 'XXX-1', 'done')
    s.tick(30_000)
    const recent = addRun(s, 'XXX-2', 'done')
    const ended = Date.parse(s.runs.get(recent.id)?.endedAt ?? '')
    const t = fakeTmux([pane('%11', old.id, 'XXX-1', 'XXX-1 [done]'), pane('%12', recent.id, 'XXX-2')])
    expect(syncPanes(ctxAt(s, ended + 40_000), t.tmux, { issues: [], maxPanes: 6 })).toEqual([])
    expect(killed(t.calls)).toEqual(['%11'])
    expect(t.calls).toContainEqual(['select-layout', '-t', '@2', 'tiled'])
    expect(t.calls).toContainEqual(['select-pane', '-t', '%12', '-T', 'XXX-2 [done]'])
    t.calls.length = 0
    syncPanes(ctxAt(s, ended + 61_000), t.tmux, { issues: [], maxPanes: 6 })
    expect(killed(t.calls)).toEqual(['%11', '%12'])
  })

  test('a pane closes no later than 60 s after its run ended, given the poll interval', () => {
    const s = seeded()
    const recent = addRun(s, 'XXX-2', 'done')
    const ended = Date.parse(s.runs.get(recent.id)?.endedAt ?? '')
    const t = fakeTmux([pane('%12', recent.id, 'XXX-2', 'XXX-2 [done]')])
    syncPanes(ctxAt(s, ended + 57_000), t.tmux, { issues: [], maxPanes: 6 })
    expect(killed(t.calls)).toEqual(['%12'])
  })

  test('ns watch on an existing session removes panes of inactive runs before attaching', async () => {
    const s = seeded()
    const old = addRun(s, 'XXX-1', 'done')
    const live = addRun(s, 'XXX-2')
    const calls: string[][] = []
    const listed = [pane('%11', old.id, 'XXX-1', 'XXX-1 [done]'), pane('%12', live.id, 'XXX-2')]
    const execs: string[][] = []
    const code = await run(
      ['watch', '--all'],
      { out: () => {}, err: () => {} },
      {
        ...s.deps,
        now: () => new Date(Date.parse(s.runs.get(old.id)?.endedAt ?? '') + 1_000),
        which: () => '/usr/bin/tmux',
        self: ['ns'],
        capture: (argv) => {
          calls.push(argv.slice(3))
          const out = argv[3] === 'list-panes' ? listed.join('\n') : ''
          return { exitCode: 0, stdout: out, stderr: '' }
        },
        exec: async (cmd) => {
          execs.push(cmd)
          return 0
        },
      },
    )
    expect(code).toBe(0)
    expect(killed(calls)).toEqual(['%11'])
    expect(calls.some((c) => c[0] === 'new-window' || c[0] === 'split-window')).toBe(false)
    expect(execs).toHaveLength(1)
  })

  test('ns watch --all on a session started for other issues shows the active run and widens the manager', async () => {
    const s = seeded()
    const old = addRun(s, 'XXX-1', 'done')
    const live = addRun(s, 'XXX-2')
    const calls: string[][] = []
    const listed = [pane('%11', old.id, 'XXX-1', 'XXX-1 [done]')]
    const code = await run(
      ['watch', '--all'],
      { out: () => {}, err: () => {} },
      {
        ...s.deps,
        now: () => new Date(Date.parse(s.runs.get(old.id)?.endedAt ?? '') + 1_000),
        which: () => '/usr/bin/tmux',
        self: ['ns'],
        capture: (argv) => {
          calls.push(argv.slice(3))
          if (argv[3] === 'list-panes') return { exitCode: 0, stdout: listed.join('\n'), stderr: '' }
          if (argv[3] === 'new-window' || argv[3] === 'split-window')
            return { exitCode: 0, stdout: '%20\n', stderr: '' }
          return { exitCode: 0, stdout: '', stderr: '' }
        },
        exec: async () => 0,
      },
    )
    expect(code).toBe(0)
    expect(killed(calls)).toEqual(['%11'])
    expect(calls.filter((c) => c[0] === 'new-window' || c[0] === 'split-window')).toHaveLength(1)
    expect(calls).toContainEqual(['set-option', '-p', '-t', '%20', '@ns-run', live.id])
    expect(calls.at(-1)).toEqual([
      'respawn-pane',
      '-k',
      '-t',
      'ns-watch:manager',
      'ns --host local watch --manage --max-panes 6',
    ])
  })

  test('a fresh watch removes panes of inactive runs and shows one pane per active run', () => {
    const s = seeded()
    const old = addRun(s, 'XXX-1', 'done')
    const live = addRun(s, 'XXX-2')
    const t = fakeTmux([pane('%11', old.id, 'XXX-1', 'XXX-1 [done]'), pane('%12', 'GONE', 'XXX-0')])
    const at = Date.parse(s.runs.get(old.id)?.endedAt ?? '') + 1_000
    expect(syncPanes(ctxAt(s, at), t.tmux, { issues: [], maxPanes: 6, fresh: true })).toEqual(['XXX-2'])
    expect(killed(t.calls)).toEqual(['%11', '%12'])
    expect(t.calls.filter((c) => c[0] === 'new-window' || c[0] === 'split-window')).toHaveLength(1)
    expect(t.calls).toContainEqual(['set-option', '-p', '-t', '%20', '@ns-run', live.id])
  })

  test('ctrl+c in a stream pane does not end the tail', async () => {
    const s = seeded()
    addRun(s, 'XXX-1')
    const t = fakeTmux([])
    syncPanes(ctxAt(s, NOW), t.tmux, { issues: [], maxPanes: 6 })
    const line = t.calls.find((c) => c[0] === 'new-window')?.at(-1) ?? ''
    expect(line).toContain('ns --host local tail --no-footer XXX-1')
    expect(line).toBe("trap '' INT; exec ns --host local tail --no-footer XXX-1")
    const script = line.replace('ns --host local tail --no-footer XXX-1', 'sh -c "sleep 0.5; echo alive"')
    const proc = Bun.spawn(['env', '--default-signal=INT', 'sh', '-c', script], { stdout: 'pipe' })
    await Bun.sleep(150)
    proc.kill('SIGINT')
    expect(await proc.exited).toBe(0)
    expect(await new Response(proc.stdout).text()).toBe('alive\n')
  })

  test('the attach key on a finished run says so and respawns nothing', async () => {
    const s = seeded()
    const done = addRun(s, 'XXX-1', 'done')
    const calls: string[][] = []
    const show: Record<string, string> = { '@ns-issue': 'XXX-1', '@ns-run': done.id }
    const code = await run(
      ['watch', '--swap', '%11'],
      { out: () => {}, err: () => {} },
      {
        ...s.deps,
        which: () => '/usr/bin/tmux',
        self: ['ns'],
        capture: (argv) => {
          calls.push(argv.slice(3))
          const v = argv[3] === 'show-options' ? (show[argv.at(-1) ?? ''] ?? '') : ''
          return { exitCode: 0, stdout: `${v}\n`, stderr: '' }
        },
      },
    )
    expect(code).toBe(0)
    expect(calls.some((c) => c[0] === 'respawn-pane')).toBe(false)
    expect(calls.at(-1)).toEqual(['display-message', '-t', '%11', 'XXX-1 is not running'])
  })

  test('the attach key in a pane without a worker says so and exits 0', async () => {
    const s = seeded()
    const calls: string[][] = []
    const r = await cli(['watch', '--swap', '%0'], {
      ...s.deps,
      which: () => '/usr/bin/tmux',
      self: ['ns'],
      capture: (argv) => {
        calls.push(argv.slice(3))
        return { exitCode: 0, stdout: '\n', stderr: '' }
      },
    })
    expect(r).toEqual({ code: 0, out: [], err: [] })
    expect(calls.some((c) => c[0] === 'respawn-pane')).toBe(false)
    expect(calls.at(-1)).toEqual(['display-message', '-t', '%0', 'no worker in this pane'])
  })
})
