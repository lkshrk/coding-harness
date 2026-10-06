import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { indexDb } from './index'
import { sqliteCodeGraph } from './query'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ns-graph-'))
  const db = new Database(join(dir, indexDb('omni')))
  db.run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, project TEXT, label TEXT, name TEXT,
    qualified_name TEXT, file_path TEXT, start_line INTEGER, end_line INTEGER, properties TEXT)`)
  db.run(`CREATE TABLE edges (id INTEGER PRIMARY KEY, project TEXT, source_id INTEGER,
    target_id INTEGER, type TEXT, properties TEXT)`)
  const node = db.prepare(
    'INSERT INTO nodes (id, project, label, name, qualified_name, file_path, start_line, properties) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const sig = (signature: string, return_type = '') => JSON.stringify({ signature, return_type })
  node.run(1, 'omni', 'Function', 'run', 'q.a.run', 'src/a.ts', 3, sig('(x: number)', ': void'))
  node.run(2, 'omni', 'Function', 'useRun', 'q.caller.useRun', 'src/caller.ts', 5, sig('()'))
  node.run(3, 'omni', 'Class', 'Helper', 'q.callee.Helper', 'src/callee.ts', 1, '{}')
  node.run(
    4,
    'omni',
    'Method',
    'go',
    'q.callee.Helper.go',
    'src/callee.ts',
    2,
    sig('(n: number)', ': string'),
  )
  node.run(5, 'omni', 'Variable', 'x', 'q.callee.x', 'src/callee.ts', 9, '{}')
  node.run(6, 'omni', 'Function', 'other', 'q.other.other', 'src/other.ts', 1, '{}')
  node.run(7, 'other', 'Function', 'run', 'z.run', 'src/zz.ts', 1, '{}')
  const edge = db.prepare('INSERT INTO edges (project, source_id, target_id, type) VALUES (?, ?, ?, ?)')
  edge.run('omni', 2, 1, 'CALLS')
  edge.run('omni', 1, 4, 'CALLS')
  edge.run('omni', 1, 3, 'CALLS')
  edge.run('omni', 6, 4, 'CALLS')
  edge.run('omni', 1, 6, 'USAGE')
  edge.run('other', 7, 1, 'CALLS')
  db.close()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('sqliteCodeGraph', () => {
  test('missing index yields no graph', () => {
    expect(sqliteCodeGraph(dir, 'nope')).toBeUndefined()
  })

  test('neighbours are direct callers and callees, most edges first, issue files excluded', () => {
    const g = sqliteCodeGraph(dir, 'omni')
    try {
      expect(g?.neighbours(['src/a.ts'])).toEqual([
        { path: 'src/callee.ts', edges: 2 },
        { path: 'src/caller.ts', edges: 1 },
      ])
      expect(g?.neighbours([])).toEqual([])
    } finally {
      g?.close()
    }
  })

  test('outline lists symbols with signatures in line order', () => {
    const g = sqliteCodeGraph(dir, 'omni')
    try {
      expect(g?.outline('src/callee.ts')).toBe('L1 class Helper\n  L2 method go(n: number): string')
      expect(g?.outline('src/missing.ts')).toBe('')
    } finally {
      g?.close()
    }
  })
})
