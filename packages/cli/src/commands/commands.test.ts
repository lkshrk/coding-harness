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
import { ControlFailure, type ControlFn } from '../client'
import { type CliDeps, run } from '../run'

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
    expect(rec.calls).toEqual([
      ['POST', '/retry', { target: 'XXX-42', agent: 'fixer', profile: 'quality' }],
      ['POST', '/retry', { target: 'XXX-42', continue: true }],
    ])
    const refused = recording(new ControlFailure(5, 'XXX-42: stage design has no automatic role', 'refused'))
    expect((await cli(['retry', 'XXX-42'], { ...s.deps, control: refused.control })).code).toBe(5)
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
    expect(r).toEqual({ code: 0, out: [], err: [] })
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
    await cli(['attach', 'XXX-42'], t.deps)
    await cli(['attach', 'XXX-42', '--shell'], t.deps)
    expect(t.execs.map((e) => e.cmd)).toEqual([info.fallback, info.shell])
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

  test('an issue without runs exits 4', async () => {
    const s = seeded()
    expect((await cli(['tail', 'XXX-1'], s.deps)).code).toBe(4)
  })
})
