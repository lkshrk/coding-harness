import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../../stages/gates/testing'
import type { CommandResult, DockerCli } from '../worker/docker'
import { CodeGraphIndex } from '.'

let root: string
let checkout: string
let sha: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ns-graph-'))
  checkout = join(root, 'checkout')
  mkdirSync(checkout)
  git(checkout, 'init', '-q', '-b', 'main')
  writeFileSync(join(checkout, 'a.ts'), 'export const a = 1\n')
  git(checkout, 'add', '-A')
  git(checkout, 'commit', '-q', '-m', 'base')
  sha = git(checkout, 'rev-parse', 'HEAD')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

class IndexingDocker implements DockerCli {
  readonly calls: string[][] = []
  exitCode = 0
  async run(args: string[]): Promise<CommandResult> {
    this.calls.push(args)
    const src = args[args.indexOf('-v') + 1]?.split(':')[0] ?? ''
    const idx = args[args.lastIndexOf('-v') + 1]?.split(':')[0] ?? ''
    if (this.exitCode === 0) {
      expect(existsSync(join(src, 'a.ts'))).toBe(true)
      writeFileSync(join(idx, 'omni.db'), 'db')
      mkdirSync(join(idx, 'logs'))
    }
    return { exitCode: this.exitCode, stdout: '', stderr: 'boom', durationMs: 1, timedOut: false }
  }
  async *lines(): AsyncIterable<string> {}
}

function index(docker: DockerCli) {
  return new CodeGraphIndex({
    root: join(root, 'index'),
    docker,
    image: async () => 'img:1',
    user: '1000:1000',
  })
}

describe('CodeGraphIndex', () => {
  test('builds once per base commit offline from a git archive and points current at it', async () => {
    const docker = new IndexingDocker()
    const graphs = index(docker)
    const [one, two] = await Promise.all([
      graphs.ensure('omni', checkout, sha),
      graphs.ensure('omni', checkout, sha),
    ])
    expect(one).toBe(join(root, 'index', 'omni', sha))
    expect(two).toBe(one)
    expect(await graphs.ensure('omni', checkout, sha)).toBe(one)
    expect(docker.calls).toHaveLength(1)
    expect(docker.calls[0]?.slice(0, 6)).toEqual(['run', '--rm', '--network', 'none', '--user', '1000:1000'])
    expect(docker.calls[0]).toContain('img:1')
    expect(existsSync(join(one, 'omni.db'))).toBe(true)
    expect(existsSync(join(one, 'logs'))).toBe(false)
    expect(statSync(one).mode & 0o777).toBe(0o755)
    expect(statSync(join(one, 'omni.db')).mode & 0o777).toBe(0o644)
    expect(readlinkSync(join(root, 'index', 'omni', 'current'))).toBe(sha)
  })

  test('a failed build leaves no index and no build directory behind', async () => {
    const docker = new IndexingDocker()
    docker.exitCode = 1
    await expect(index(docker).ensure('omni', checkout, sha)).rejects.toThrow('failed: boom')
    expect(existsSync(join(root, 'index', 'omni', sha))).toBe(false)
    expect(existsSync(join(root, 'index', 'omni', 'current'))).toBe(false)
  })

  test('prune keeps current and in-use commits and removes the rest', async () => {
    const graphs = index(new IndexingDocker())
    await graphs.ensure('omni', checkout, sha)
    for (const old of ['old1', 'old2']) mkdirSync(join(root, 'index', 'omni', old))
    expect(graphs.prune('omni', ['old2']).sort()).toEqual(['old1'])
    expect(existsSync(join(root, 'index', 'omni', sha))).toBe(true)
    expect(existsSync(join(root, 'index', 'omni', 'old2'))).toBe(true)
  })
})
