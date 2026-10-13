import { describe, expect, test } from 'bun:test'
import type { Config } from '@nightshift/core'
import { controlHandler } from '../control/socket/server'
import { snapshot } from '../testing/testing'
import { files, harness } from './testing'

const post = (sup: Parameters<typeof controlHandler>[0], body: unknown) =>
  controlHandler(sup)(
    new Request('http://localhost/implement', { method: 'POST', body: JSON.stringify(body) }),
  )

const backlog = (identifier: string, blockedBy: string[] = [], file = identifier) =>
  snapshot({
    identifier,
    status: 'Backlog',
    labels: [],
    estimate: 2,
    description: files(`src/${file}.ts`),
    project: { id: 'p-omni', name: 'Omni', initiatives: [], labels: [] },
    blockedBy: blockedBy.map((b) => ({ identifier: b, team: 'FOR', status: 'Backlog' })),
  })

const withProfile = (config: Config, name: string) => {
  ;(config.profiles as Record<string, unknown>)[name] = structuredClone(config.profiles.default)
}

const choices = (h: ReturnType<typeof harness>) =>
  h.db.query('SELECT project, key, value FROM session_choices').all()

describe('POST /implement', () => {
  test('a blocking cycle is refused with the cycle and writes nothing', async () => {
    const h = harness()
    h.linear.put(backlog('FOR-1', ['FOR-2']), backlog('FOR-2', ['FOR-1']), backlog('FOR-3'))
    const res = await post(h.sup, { project: 'Omni', merge_mode: 'auto' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      'cycle: FOR-1 → FOR-2 → FOR-1',
    )
    expect(h.linear.updates).toEqual([])
    expect(h.linear.get('FOR-3').project?.labels).toEqual([])
    expect(h.sup.covered()).toEqual([])
    expect(h.of('COVERAGE_CHANGED')).toEqual([])
  })

  test('a valid project is labelled, covered and released', async () => {
    const h = harness()
    h.linear.put(
      backlog('FOR-1', [], 'shared'),
      backlog('FOR-2', ['FOR-1']),
      { ...backlog('FOR-3', [], 'shared'), delegated: false },
      snapshot({ identifier: 'FOR-4', status: 'Done', estimate: 1, project: backlog('x').project }),
    )
    const res = await post(h.sup, { project: 'Omni', merge_mode: 'auto' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ready: ['FOR-1', 'FOR-3'],
      waiting: ['FOR-2'],
      warnings: ['FOR-1 and FOR-3 both touch src/shared.ts; they will run one after the other'],
    })
    for (const id of ['FOR-1', 'FOR-2', 'FOR-3'])
      expect(h.linear.get(id).project?.labels).toEqual(['ai-merge:auto'])
    expect(h.linear.get('FOR-1')).toMatchObject({ status: 'Todo', labels: ['ai-stage:implementation'] })
    expect(h.linear.get('FOR-3')).toMatchObject({ status: 'Todo', labels: ['ai-stage:implementation'] })
    expect(h.linear.get('FOR-2')).toMatchObject({ status: 'Backlog', labels: ['ai-stage:implementation'] })
    expect(h.sup.covered().sort()).toEqual(['FOR-1', 'FOR-2', 'FOR-3'])

    const again = await post(h.sup, { project: 'Omni', merge_mode: 'auto' })
    expect(again.status).toBe(200)
    expect(h.of('COVERAGE_CHANGED')).toHaveLength(3)
  })

  test('the profile is recorded and used by the next dispatch', async () => {
    const h = harness()
    withProfile(h.config, 'fast')
    h.linear.put(backlog('FOR-1'))
    await h.sup.start()
    const res = await post(h.sup, { project: 'Omni', merge_mode: 'manual', profile: 'fast' })
    expect(res.status).toBe(200)
    expect(choices(h)).toEqual([{ project: 'p-omni', key: 'profile', value: 'fast' }])
    expect((await h.sup.tick()).dispatched).toEqual(['FOR-1'])
    expect(h.of('DISPATCHED')[0]?.data.profile).toBe('fast')
  })

  test('an unknown profile is refused before any write', async () => {
    const h = harness()
    h.linear.put(backlog('FOR-1'))
    const res = await post(h.sup, { project: 'Omni', merge_mode: 'auto', profile: 'fast' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("no profile 'fast'")
    expect(h.linear.updates).toEqual([])
    expect(h.linear.get('FOR-1').project?.labels).toEqual([])
    expect(choices(h)).toEqual([])
    expect(h.sup.covered()).toEqual([])
  })

  test('an unknown project answers 404', async () => {
    const h = harness()
    const res = await post(h.sup, { project: 'Nope', merge_mode: 'auto' })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "no Linear project 'Nope'",
    )
  })

  test('merge mode feature-branch is a schema violation', async () => {
    const h = harness()
    const res = await post(h.sup, { project: 'Omni', merge_mode: 'feature-branch' })
    expect(res.status).toBe(400)
    expect(h.linear.updates).toEqual([])
  })
})
