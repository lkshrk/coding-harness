import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, gitFixture } from '../../stages/gates/testing'
import { importBundle, isTestFile, runRef, writeReviewArtifacts } from './host'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ns-host-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('importBundle', () => {
  test('fetches the run branch into refs/nightshift/<run> only', () => {
    const fx = gitFixture(root)
    const before = fx.hostState()
    const { bundle, headSha } = fx.bundle()

    expect(importBundle(fx.checkout, bundle, fx.branch, '01RUN')).toBe(headSha)
    expect(git(fx.checkout, 'rev-parse', runRef('01RUN'))).toBe(headSha)
    expect(fx.hostState()).toBe(before)
  })

  test('is idempotent', () => {
    const fx = gitFixture(root)
    const { bundle, headSha } = fx.bundle()
    importBundle(fx.checkout, bundle, fx.branch, '01RUN')
    expect(importBundle(fx.checkout, bundle, fx.branch, '01RUN')).toBe(headSha)
  })
})

describe('writeReviewArtifacts', () => {
  test('writes the diff and lists existing test files the diff touches', () => {
    const fx = gitFixture(root)
    const { bundle, headSha } = fx.bundle()
    importBundle(fx.checkout, bundle, fx.branch, '01RUN')
    const out = writeReviewArtifacts(fx.checkout, fx.base, headSha, join(root, 'artifacts', '01RUN'))

    expect(out.tests).toEqual(['src/a.test.ts'])
    expect(readFileSync(out.testsTouched, 'utf8')).toBe('src/a.test.ts\n')
    const diff = readFileSync(out.diff, 'utf8')
    expect(diff).toContain('-expect(a).toBe(1)')
    expect(diff).toContain('+export const b = 2')
  })
})

describe('isTestFile', () => {
  test.each([
    ['src/a.test.ts', true],
    ['pkg/x_test.go', true],
    ['tests/test_api.py', true],
    ['spec/model_spec.rb', true],
    ['src/__tests__/a.tsx', true],
    ['src/latest.ts', false],
    ['Makefile', false],
  ])('%s → %p', (path, expected) => {
    expect(isTestFile(path)).toBe(expected)
  })
})
