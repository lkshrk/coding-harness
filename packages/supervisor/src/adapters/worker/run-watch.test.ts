import { expect, test } from 'bun:test'
import type { HarnessEvent, WorkerSession } from '../../ports'
import type { Run } from '../../ports/records'
import { Channel } from './channel'
import { RunWatch, type WorkerCallbacks } from './run-watch'
import { FakeSandboxDriver } from './testing'
import { WATCH_DEFAULTS } from './watch'

const run = { id: '01JRUN0000000000000000000A', issue: 'FOR-1', baseSha: 'base1' } as Run
const session: WorkerSession = { id: 'ses_1', attach: [] }

const rejection = (errors: string[]): HarnessEvent => ({
  kind: 'tool_result',
  tool: 'finish',
  ok: false,
  error: `Invalid finish payload:\n${errors.map((e) => `- ${e}`).join('\n')}\nCorrect it and call finish again.`,
})

function setup() {
  const stream = new Channel<HarnessEvent>()
  const calls: [string, ...unknown[]][] = []
  const stopped: string[] = []
  const callbacks: WorkerCallbacks = {
    workerStarted: async () => undefined,
    workerStalled: async () => undefined,
    workerFinished: async (id, payload) => {
      calls.push(['finished', id, payload])
    },
    workerFailed: async (id, reason, detail) => {
      calls.push(['failed', id, reason, detail])
    },
    finishRejected: async (id, info) => {
      calls.push(['rejected', id, info])
    },
  }
  const watch = new RunWatch({
    sandbox: new FakeSandboxDriver(),
    worker: {
      events: () => stream,
      send: async () => undefined,
      stop: async (_s, reason) => {
        stopped.push(reason)
      },
    },
    thresholds: WATCH_DEFAULTS,
    tickMs: 60_000,
    now: () => 0,
    callbacks: () => callbacks,
  })
  watch.watch(
    run,
    session,
    { driver: 'docker', id: 'ctr', name: 'ctr' },
    '/w',
    {
      steps: 100,
      wallClockMs: 3_600_000,
      tokens: 1_000_000,
      graceTurns: 1,
    },
    0,
  )
  const of = (kind: string) => calls.filter((c) => c[0] === kind)
  return { stream, of, stopped }
}

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i++) await Bun.sleep(2)
  expect(pred()).toBe(true)
}

test('a rejected finish is reported with the attempt and the plugin error lines', async () => {
  const { stream, of } = setup()
  stream.push(
    rejection([
      'report.files: must NOT have more than 10 items',
      'report: must NOT have additional properties',
    ]),
  )
  await until(() => of('rejected').length === 1)
  expect(of('rejected')[0]).toEqual([
    'rejected',
    run.id,
    {
      attempt: 1,
      errors:
        '- report.files: must NOT have more than 10 items\n- report: must NOT have additional properties',
    },
  ])
  expect(of('failed')).toEqual([])
})

test('the reported errors are cut to 2000 characters', async () => {
  const { stream, of } = setup()
  stream.push(rejection(['x'.repeat(3000)]))
  await until(() => of('rejected').length === 1)
  expect(of('rejected')[0]?.[2]).toEqual({ attempt: 1, errors: `- ${'x'.repeat(1998)}` })
})

test('a valid finish after one rejection ends the run as finished', async () => {
  const { stream, of, stopped } = setup()
  stream.push(rejection(['status: required']))
  stream.push({ kind: 'finish', payload: { status: 'DONE' } })
  await until(() => of('finished').length === 1)
  expect(of('failed')).toEqual([])
  expect(stopped).toEqual(['finished'])
})

test('two rejections followed by a valid finish end the run as finished', async () => {
  const { stream, of, stopped } = setup()
  stream.push(rejection(['status: required']))
  stream.push(rejection(['summary: required']))
  stream.push({ kind: 'finish', payload: { status: 'DONE' } })
  await until(() => of('finished').length === 1)
  expect(of('rejected').map((c) => (c[2] as { attempt: number }).attempt)).toEqual([1, 2])
  expect(of('failed')).toEqual([])
  expect(stopped).toEqual(['finished'])
})

test('three rejections fail the run with no_finish naming the last errors', async () => {
  const { stream, of, stopped } = setup()
  stream.push(rejection(['status: required']))
  stream.push(rejection(['summary: required']))
  stream.push(rejection(['report.why: must NOT have more than 300 characters']))
  await until(() => of('failed').length === 1)
  expect(of('rejected').map((c) => (c[2] as { attempt: number }).attempt)).toEqual([1, 2, 3])
  expect(of('failed')[0]).toEqual([
    'failed',
    run.id,
    'no_finish',
    'finish payload invalid after 3 attempts; last errors:\n- report.why: must NOT have more than 300 characters',
  ])
  expect(stopped).toEqual(['no_finish'])
})

test('a rejection without error text is still counted and reported', async () => {
  const { stream, of } = setup()
  stream.push({ kind: 'tool_result', tool: 'finish', ok: false })
  await until(() => of('rejected').length === 1)
  expect(of('rejected')[0]?.[2]).toEqual({ attempt: 1, errors: '' })
})
