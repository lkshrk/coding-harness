import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openState } from '../../state/db'
import { issueRecords, questionRecords, workerRecords } from '../../state/records'
import { Supervisor, type SupervisorDeps } from '../../supervisor/supervisor'
import {
  FakeExecutor,
  FakeLinear,
  FakeNotifier,
  FakeOutbox,
  FakeSandbox,
  FakeWorker,
  snapshot,
  testConfig,
} from '../../testing/testing'
import type { AttachInfo } from '../generated/control'
import { type ControlServer, serveControl } from './server'

const KINDS: Record<string, 'worker' | 'single_call'> = {
  intake: 'single_call',
  reviewer: 'single_call',
  implementer: 'worker',
  'implementer-strong': 'worker',
  fixer: 'worker',
  repairer: 'worker',
}

const dirs: string[] = []
const servers: ControlServer[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function harness(over: Partial<SupervisorDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-sock-'))
  dirs.push(dir)
  const t = Date.parse('2026-10-04T10:00:00.000Z')
  const now = () => new Date(t)
  const config = testConfig()
  ;(config.profiles as Record<string, unknown>).quality = structuredClone(config.profiles.default)
  const db = openState(join(dir, 'state.db'))
  const linear = new FakeLinear(config, now)
  const executor = new FakeExecutor()
  const sandbox = new FakeSandbox()
  const make = () =>
    new Supervisor({
      config,
      db,
      linear,
      executor,
      sandbox,
      worker: new FakeWorker(),
      notifier: new FakeNotifier(),
      outbox: new FakeOutbox(),
      repos: { baseSha: async () => 'base1' },
      agentKind: (a) => KINDS[a],
      modelFor: (agent, profile) => `${profile}/${agent}`,
      now,
      instanceId: 'inst-1',
      ...over,
    })
  const sup = make()
  const path = join(dir, 'nightshift.sock')
  const attach: AttachInfo = {
    url: 'http://127.0.0.1:49152',
    password: 'pw',
    session: 'ses_1',
    workdir: '/work/omni',
    fallback: ['docker', 'exec', '-it', 'c1', 'sh'],
    shell: ['docker', 'exec', '-it', 'c1', 'bash'],
  }
  const server = serveControl(sup, path, {
    attach: (run) => (run.session ? attach : undefined),
    version: '9.9.9',
  })
  servers.push(server)
  const req = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`http://localhost${route}`, {
      unix: path,
      method,
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const of = (type: string) => sup.log.since(null).filter((e) => e.type === type)
  return { dir, sup, make, db, linear, executor, sandbox, path, server, req, of }
}

async function running(h: ReturnType<typeof harness>, identifier = 'FOR-1') {
  h.linear.put(snapshot({ identifier }))
  await h.sup.start()
  await h.sup.tick()
  const run = h.sup.runs.forIssue(identifier).at(-1)
  if (!run) throw new Error('not dispatched')
  h.sandbox.add(run.id)
  await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 'ses_1' })
  return h.sup.runs.get(run.id) ?? run
}

describe('control socket', () => {
  test('is created with mode 0600, replaces a stale file and is removed on close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-sock-'))
    dirs.push(dir)
    const path = join(dir, 'nightshift.sock')
    writeFileSync(path, 'stale')
    const h = harness()
    const server = serveControl(h.sup, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(h.path).mode & 0o777).toBe(0o600)
    server.close()
    expect(() => statSync(path)).toThrow()
  })

  test('GET /health reports dispatch, gateway and version', async () => {
    const h = harness()
    await h.sup.start()
    expect((await h.req('GET', '/health')).body).toEqual({
      dispatch: 'running',
      gateway: 'ok',
      version: '9.9.9',
    })
    h.sup.log.append({ type: 'GATEWAY_UNAVAILABLE', data: { reason: 'down' } })
    h.sup.pause('x', 'supervisor')
    expect((await h.req('GET', '/health')).body).toMatchObject({ dispatch: 'paused', gateway: 'unavailable' })
  })

  test('pause and resume record by: cli; running workers continue', async () => {
    const h = harness()
    const run = await running(h)
    h.linear.put(
      snapshot({ identifier: 'FOR-2', description: snapshot({ identifier: 'FOR-2' }).description }),
    )
    expect(await h.req('POST', '/pause', {})).toEqual({ status: 200, body: { ok: true } })
    expect(h.of('DISPATCH_PAUSED').at(-1)?.data).toEqual({ reason: 'ns pause', by: 'cli' })
    expect((await h.sup.tick()).dispatched).toEqual([])
    expect(h.sup.runs.get(run.id)?.state).toBe('running')
    await h.req('POST', '/resume', {})
    expect(h.of('DISPATCH_RESUMED').at(-1)?.data).toEqual({ reason: 'ns resume', by: 'cli' })
  })

  test('a per-issue hold is persisted and survives a new supervisor instance', async () => {
    const h = harness()
    h.linear.put(snapshot({ identifier: 'FOR-1' }))
    await h.sup.start()
    await h.req('POST', '/pause', { issue: 'FOR-1' })
    expect(h.of('DISPATCH_PAUSED').at(-1)).toMatchObject({ issue: 'FOR-1', data: { by: 'cli' } })
    const again = h.make()
    await again.start()
    const report = await again.tick()
    expect(report.dispatched).toEqual([])
    expect(report.waiting).toContainEqual({ identifier: 'FOR-1', reason: 'held' })
    expect(again.held()).toEqual(['FOR-1'])
    again.unhold('FOR-1', 'cli')
    expect((await again.tick()).dispatched).toEqual(['FOR-1'])
  })

  test('POST /cover covers and releases an issue with an event', async () => {
    const h = harness()
    await h.req('POST', '/cover', { issue: 'FOR-7', covered: true })
    expect(h.sup.covered()).toEqual(['FOR-7'])
    await h.req('POST', '/cover', { issue: 'FOR-7', covered: false })
    expect(h.sup.covered()).toEqual([])
    expect(h.of('COVERAGE_CHANGED').map((e) => e.data)).toEqual([
      { covered: true, by: 'cli' },
      { covered: false, by: 'cli' },
    ])
  })

  test('errors use one shape with a code', async () => {
    const h = harness()
    expect(await h.req('POST', '/pause', '{nope')).toEqual({
      status: 400,
      body: { error: { code: 'bad_request', message: 'body is not JSON' } },
    })
    expect((await h.req('POST', '/cover', { issue: 'nope', covered: true })).body).toMatchObject({
      error: { code: 'bad_request' },
    })
    expect(await h.req('GET', '/nowhere')).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'no route GET /nowhere' } },
    })
  })

  test('POST /send delivers to the session and logs MESSAGE_SENT', async () => {
    const h = harness()
    const run = await running(h)
    const res = await h.req('POST', '/send', { target: 'FOR-1', message: 'use the existing retry helper' })
    expect(res).toEqual({ status: 200, body: { ok: true } })
    expect(h.executor.calls.at(-1)).toEqual({
      op: 'nudge',
      run: run.id,
      detail: 'use the existing retry helper',
    })
    expect(h.of('MESSAGE_SENT').at(-1)).toMatchObject({
      issue: 'FOR-1',
      run: run.id,
      data: { text: 'use the existing retry helper', by: 'cli' },
    })
    expect(await h.req('POST', '/send', { target: 'FOR-9', message: 'x' })).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'no active run for FOR-9' } },
    })
  })

  test('POST /answer replies under the open question; the next sweep records the answer', async () => {
    const h = harness()
    const run = await running(h)
    await h.sup.workerFinished(run.id, {
      status: 'NEEDS_CONTEXT',
      summary: 's',
      evidence: [],
      blocker: { needs: 'decision', reason: 'r', question: 'which table?' },
    })
    const question = h.of('QUESTION_ASKED')[0]?.data.comment as string
    expect((await h.req('POST', '/answer', { issue: 'FOR-1', text: 'use runs' })).status).toBe(200)
    const reply = (await h.linear.comments('FOR-1')).at(-1)
    expect(reply).toMatchObject({ body: 'use runs', parentId: question })
    expect(h.of('MESSAGE_SENT').at(-1)?.data).toEqual({ text: 'use runs', by: 'cli', comment: question })
    await h.sup.tick()
    expect(h.of('QUESTION_ANSWERED').at(-1)?.data).toMatchObject({ comment: question, answer: 'use runs' })
    expect((await h.req('POST', '/answer', { issue: 'FOR-1', text: 'again' })).status).toBe(404)
  })

  test('POST /stop stops the run, destroys the sandbox, releases the lease and holds the issue', async () => {
    const h = harness()
    const run = await running(h)
    const res = await h.req('POST', '/stop', { target: run.id, reason: 'wrong approach' })
    expect(res).toEqual({ status: 200, body: { run: run.id } })
    expect(h.sup.runs.get(run.id)?.state).toBe('stopped')
    expect(h.sandbox.destroyed).toEqual([`sb-${run.id}`])
    expect(h.sup.leases.get('FOR-1')).toBeUndefined()
    expect(h.sup.awaiting('FOR-1')).toEqual({ kind: 'escalated', stage: 'implementation' })
    expect(h.linear.get('FOR-1').status).toBe('Blocked')
    expect(h.of('WORKER_FAILED').at(-1)?.data).toEqual({
      reason: 'stopped',
      detail: 'wrong approach',
      by: 'cli',
    })
    expect((await h.req('POST', '/stop', { target: 'FOR-1' })).status).toBe(404)
  })

  test('POST /retry stops the active run and dispatches attempt + 1 on the requested profile', async () => {
    const h = harness()
    const first = await running(h)
    const res = await h.req('POST', '/retry', { target: 'FOR-1', profile: 'quality' })
    expect(res.status).toBe(200)
    const next = h.sup.runs.get(res.body.run as string)
    expect(h.sup.runs.get(first.id)?.state).toBe('stopped')
    expect(next).toMatchObject({
      attempt: 2,
      profile: 'quality',
      model: 'quality/implementer',
      issue: 'FOR-1',
    })
    expect(h.of('DISPATCHED').at(-1)?.data).toMatchObject({
      profile: 'quality',
      attempt: 2,
      by: 'cli',
      reason: 'manual retry',
    })
    expect(h.sup.escalationCount('FOR-1')).toBe(0)
  })

  test('POST /retry with continue resumes from the latest attempt that has a commit', async () => {
    const h = harness()
    const first = await running(h)
    expect((await h.req('POST', '/retry', { target: 'FOR-1', continue: true })).body).toMatchObject({
      error: { code: 'refused' },
    })
    await h.sup.headImported(first.id, 'head1')
    const res = await h.req('POST', '/retry', { target: 'FOR-1', continue: true })
    expect(res.status).toBe(200)
    expect(h.executor.starts.at(-1)?.repairFrom).toEqual({ run: first.id, headSha: 'head1' })
  })

  test('POST /retry is refused for a stage without an automatic role and unknown targets are not found', async () => {
    const h = harness()
    h.linear.put(snapshot({ identifier: 'FOR-3', labels: ['ai-stage:design'] }))
    await h.sup.start()
    expect((await h.req('POST', '/retry', { target: 'FOR-3' })).body).toMatchObject({
      error: { code: 'refused' },
    })
    expect((await h.req('POST', '/retry', { target: 'FOR-3', profile: 'nope' })).status).toBe(409)
    expect((await h.req('POST', '/retry', { target: 'FOR-404' })).status).toBe(404)
  })

  test('GET /runs/<target>/attach returns the connection of a running worker only', async () => {
    const h = harness()
    const run = await running(h)
    const res = await h.req('GET', `/runs/${run.id}/attach`)
    expect(res.body).toMatchObject({ url: 'http://127.0.0.1:49152', session: 'ses_1' })
    expect((await h.req('GET', '/runs/FOR-1/attach')).status).toBe(200)
    expect(await h.req('GET', '/runs/FOR-2/attach')).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'no active run for FOR-2' } },
    })
  })
})

describe('read records', () => {
  test('each tick snapshots managed issues for tasks; workers and questions read from runs and events', async () => {
    const h = harness()
    const run = await running(h)
    h.linear.put(snapshot({ identifier: 'FOR-2', labels: ['ai-stage:design'], blockedBy: [] }))
    await h.sup.workerProgress(run.id, { steps: 4, tool_calls: 3, tokens: 900, last_tool: 'edit' })
    await h.sup.tick()
    const issues = issueRecords(h.db) ?? []
    expect(issues.map((i) => [i.identifier, i.stage, i.lifecycle, i.agent_state, i.attempt])).toEqual([
      ['FOR-1', 'implementation', 'running', 'running', 1],
      ['FOR-2', 'design', 'ready', null, 0],
    ])
    expect(workerRecords(h.db, new Date('2026-10-04T10:05:00.000Z'))).toEqual([
      expect.objectContaining({
        issue: 'FOR-1',
        agent: 'implementer',
        model: 'default/implementer',
        steps: 4,
        tokens: 900,
        last_tool: 'edit',
        elapsed_ms: 300_000,
      }),
    ])
    await h.sup.workerFinished(run.id, {
      status: 'NEEDS_CONTEXT',
      summary: 's',
      evidence: [],
      blocker: { needs: 'decision', reason: 'r', question: 'A or B?' },
    })
    const [q] = questionRecords(h.db)
    expect(q).toMatchObject({ issue: 'FOR-1', asked_to: 'user', question: 'A or B?' })
    expect(q?.url).toBe(`https://linear.app/h-cloud/issue/FOR-1#comment-${q?.comment.slice(0, 8)}`)
  })
})
