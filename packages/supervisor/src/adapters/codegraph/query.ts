import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CodeGraph } from '../../ports/context'
import { indexDb } from './index'

export type { CodeGraph, Neighbour } from '../../ports/context'

const OUTLINE_LABELS = ['Class', 'Interface', 'Type', 'Enum', 'Function', 'Method']
const MAX_OUTLINE_SYMBOLS = 60

type SymbolRow = { label: string; name: string; start_line: number; properties: string }

function signatureOf(properties: string): string {
  try {
    const p = JSON.parse(properties) as { signature?: unknown; return_type?: unknown }
    const sig = typeof p.signature === 'string' ? p.signature : ''
    const ret = typeof p.return_type === 'string' ? p.return_type : ''
    return `${sig}${ret}`.replace(/\s+/g, ' ')
  } catch {
    return ''
  }
}

export function sqliteCodeGraph(indexPath: string, project: string): CodeGraph | undefined {
  const file = join(indexPath, indexDb(project))
  if (!existsSync(file)) return undefined
  const db = new Database(file, { readonly: true })
  return {
    neighbours(files) {
      if (files.length === 0) return []
      const rows = db
        .query<{ path: string; edges: number }, [string, string]>(
          `SELECT path, COUNT(*) AS edges FROM (
             SELECT t.file_path AS path FROM edges e
               JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id
               WHERE e.project = ?1 AND e.type = 'CALLS'
                 AND s.file_path IN (SELECT value FROM json_each(?2))
             UNION ALL
             SELECT s.file_path AS path FROM edges e
               JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id
               WHERE e.project = ?1 AND e.type = 'CALLS'
                 AND t.file_path IN (SELECT value FROM json_each(?2))
           )
           WHERE path <> '' AND path NOT IN (SELECT value FROM json_each(?2))
           GROUP BY path ORDER BY edges DESC, path`,
        )
        .all(project, JSON.stringify(files))
      return rows.map((r) => ({ path: r.path, edges: r.edges }))
    },
    outline(path) {
      const rows = db
        .query<SymbolRow, [string, string]>(
          `SELECT label, name, start_line, properties FROM nodes
           WHERE project = ? AND file_path = ? AND label IN (${OUTLINE_LABELS.map((l) => `'${l}'`).join(',')})
           ORDER BY start_line, name`,
        )
        .all(project, path)
      const lines = rows
        .slice(0, MAX_OUTLINE_SYMBOLS)
        .map(
          (r) =>
            `${r.label === 'Method' ? '  ' : ''}L${r.start_line} ${r.label.toLowerCase()} ${r.name}${signatureOf(r.properties)}`,
        )
      if (rows.length > MAX_OUTLINE_SYMBOLS) lines.push(`… ${rows.length - MAX_OUTLINE_SYMBOLS} more symbols`)
      return lines.join('\n')
    },
    close() {
      db.close()
    },
  }
}
