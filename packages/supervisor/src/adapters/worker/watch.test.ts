import { describe, expect, test } from 'bun:test'
import type { HarnessEvent } from '../../ports'
import { WATCH_DEFAULTS, type WatchAction, Watcher } from './watch'

const limits = { steps: 50, wallClockMs: 600_000, tokens: 10_000, graceTurns: 1 }
const step = (tokens = 10): HarnessEvent => ({ kind: 'step', step: 0, tokensIn: tokens, tokensOut: 0 })
const call = (tool: string, argsDigest = tool): HarnessEvent => ({ kind: 'tool_call', tool, argsDigest })

function feed(w: Watcher, events: HarnessEvent[], now = 0): WatchAction[] {
  return events.flatMap((e) => w.observe(e, now))
}

const stalls = (actions: WatchAction[]) => actions.flatMap((a) => (a.kind === 'stall' ? [a.signal] : []))

describe('Watcher', () => {
  test('flags zero tool calls after 3 steps, once', () => {
    const w = new Watcher(limits, WATCH_DEFAULTS, 0)
    expect(stalls(feed(w, [step(), step()]))).toEqual([])
    expect(stalls(feed(w, [step()]))).toEqual(['no_tool_calls'])
    expect(stalls(feed(w, [step(), step()]))).toEqual([])
  })

  test('a tool call before the third step keeps the guard quiet', () => {
    const w = new Watcher(limits, WATCH_DEFAULTS, 0)
    expect(stalls(feed(w, [step(), call('read'), step(), step(), step()]))).toEqual([])
  })

  test('flags the same tool call digest 4 times in a row', () => {
    const w = new Watcher(limits, WATCH_DEFAULTS, 0)
    const actions = feed(w, [call('read', 'a'), call('read', 'a'), call('read', 'b'), call('read', 'a')])
    expect(stalls(actions)).toEqual([])
    expect(stalls(feed(w, [call('read', 'a'), call('read', 'a')]))).toEqual([])
    const fourth = feed(w, [call('read', 'a')])
    expect(fourth).toEqual([
      {
        kind: 'stall',
        signal: 'repeated_tool_call',
        detail: 'read called 4 times in a row with the same input',
      },
    ])
  })

  test('flags silence while executing, but not while the session is idle', () => {
    const w = new Watcher(limits, WATCH_DEFAULTS, 0)
    w.observe(call('bash'), 1_000)
    expect(stalls(w.tick(200_000))).toEqual([])
    expect(stalls(w.tick(301_000))).toEqual(['idle'])
    expect(stalls(w.tick(400_000))).toEqual([])
    const idle = new Watcher(limits, WATCH_DEFAULTS, 0)
    idle.observe({ kind: 'idle', sinceMs: 0 }, 1_000)
    expect(stalls(idle.tick(400_000))).toEqual([])
  })

  test('flags a diff that stops growing for the configured number of steps', () => {
    const w = new Watcher(limits, { ...WATCH_DEFAULTS, noDiffGrowthSteps: 4 }, 0)
    feed(w, [call('edit'), step(), step()])
    w.diff(10)
    expect(stalls(feed(w, [step(), step(), step()]))).toEqual([])
    expect(stalls(feed(w, [step()]))).toEqual(['no_diff_growth'])
    w.diff(12)
    expect(stalls(feed(w, [step(), step(), step()]))).toEqual([])
  })

  test('reports the step, token and wall-clock caps once', () => {
    const steps = new Watcher({ ...limits, steps: 2 }, WATCH_DEFAULTS, 0)
    expect(feed(steps, [call('read'), step(), step(), step()]).filter((a) => a.kind === 'cap')).toEqual([
      { kind: 'cap', reason: 'step_cap' },
    ])
    const tokens = new Watcher(limits, WATCH_DEFAULTS, 0)
    expect(feed(tokens, [call('read'), step(6_000), step(6_000)]).filter((a) => a.kind === 'cap')).toEqual([
      { kind: 'cap', reason: 'token_cap' },
    ])
    const time = new Watcher(limits, WATCH_DEFAULTS, 0)
    expect(time.tick(600_000).filter((a) => a.kind === 'cap')).toEqual([{ kind: 'cap', reason: 'time_cap' }])
    expect(time.tick(700_000).filter((a) => a.kind === 'cap')).toEqual([])
  })

  test('emits progress every 5 steps or 60 s', () => {
    const w = new Watcher(limits, WATCH_DEFAULTS, 0)
    const actions = feed(w, [call('read'), step(), step(), step(), step(), step()], 1_000)
    expect(actions).toEqual([
      {
        kind: 'progress',
        data: { steps: 5, tool_calls: 1, tokens: 50, last_tool: 'read', tools: { read: 1 } },
      },
    ])
    expect(w.tick(30_000)).toEqual([])
    w.diff(7)
    expect(w.tick(61_000)).toEqual([
      {
        kind: 'progress',
        data: { steps: 5, tool_calls: 1, tokens: 50, diff_lines: 7, last_tool: 'read', tools: { read: 1 } },
      },
    ])
  })
})
