import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import {
  type ApplyOp,
  type ApplyResult,
  type CheckResult,
  type Config,
  createTokenProvider,
  DevcontainerEnvironmentBuilder,
  type DoctorFinding,
  describeOp,
  doctorExpectations,
  doctorReport,
  executeApply,
  expectedObjects,
  formatError,
  hostChecks,
  kvmAccessible,
  type LinearCustomView,
  LinearReader,
  type LinearWorkspace,
  type LoadResult,
  linearRequest,
  loadConfig,
  NIGHTSHIFT_ROOT,
  planApply,
  readCustomViews,
  SecretError,
  SecretResolver,
  secretRefs,
  spawnCheck,
  statfsFree,
  withCredentials,
} from '@nightshift/core'
import { resolveTarget, SignalApiError, signalApi } from '@nightshift/supervisor'
import type { Io } from './run'

export type DoctorLinear = {
  workspace: () => Promise<LinearWorkspace>
  customViews: () => Promise<LinearCustomView[]>
  apply: (ops: ApplyOp[], opts: { confirm: boolean }) => Promise<ApplyResult>
}

export type DoctorDeps = {
  load?: () => LoadResult
  secret?: (config: Config) => (ref: string) => Promise<string>
  linear?: (config: Config, secret: (ref: string) => Promise<string>) => DoctorLinear
  confirm?: (question: string) => Promise<boolean>
  interactive?: () => boolean
  which?: (bin: string) => string | null
  host?: (config: Config) => Promise<CheckResult[]>
  signalFetch?: typeof fetch
}

export type DoctorFlags = { apply: boolean; yes: boolean; json: boolean }

export const DOCTOR_USAGE = 'usage: ns doctor [--apply] [--yes] [--json]'

const SEVERITY_ORDER = ['error', 'warning', 'info']
const HOST_TOOLS: [string, string][] = [['node', 'ns env build runs @devcontainers/cli on Node']]
const LINEAR_AUTH = 'linear.auth.'

export function parseDoctorFlags(args: string[]): DoctorFlags | null {
  const flags = { apply: false, yes: false, json: false }
  for (const a of args) {
    if (a === '--apply') flags.apply = true
    else if (a === '--yes') flags.yes = true
    else if (a === '--json') flags.json = true
    else return null
  }
  return flags.yes && !flags.apply ? null : flags
}

function defaultSecret(config: Config): (ref: string) => Promise<string> {
  const resolver = new SecretResolver({
    env: withCredentials(process.env),
    rbwProfile: config.secrets.rbw_profile,
  })
  return (ref) => resolver.resolve(ref)
}

function defaultLinear(config: Config, secret: (ref: string) => Promise<string>): DoctorLinear {
  const request = linearRequest({ auth: createTokenProvider(config.linear.auth, secret) })
  const reader = new LinearReader(request)
  return {
    workspace: () => reader.workspace(),
    customViews: () => readCustomViews(request),
    apply: (ops, opts) => executeApply(ops, request, opts),
  }
}

function defaultHost(config: Config): Promise<CheckResult[]> {
  const home = homedir()
  const images = new DevcontainerEnvironmentBuilder({ config: () => config, root: NIGHTSHIFT_ROOT, home })
  return hostChecks(config, {
    run: spawnCheck,
    fetch: (url, init) => fetch(url, init),
    freeBytes: statfsFree,
    imagePresent: async (repository) => (await images.current(repository)) !== undefined,
    home,
    env: process.env,
    platform: process.platform,
    kvm: kvmAccessible,
  })
}

function hostFindings(results: CheckResult[]): DoctorFinding[] {
  return results
    .filter((r) => !r.ok)
    .map((r) => ({
      severity: r.warning ? 'warning' : 'error',
      code: 'host',
      message: `${r.name}: ${r.detail}`,
      ...(r.fix ? { fix: r.fix } : {}),
    }))
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.once('close', () => resolve(''))
      rl.question(question, resolve)
    })
    return ['y', 'yes'].includes(answer.trim().toLowerCase())
  } finally {
    rl.close()
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function secretFindings(
  config: Config,
  secret: (ref: string) => Promise<string>,
): Promise<{ findings: DoctorFinding[]; linearAuthOk: boolean }> {
  const failed = new Map<string, string[]>()
  for (const { path, ref } of secretRefs(config)) {
    try {
      await secret(ref)
    } catch (e) {
      const m = message(e)
      failed.set(m, [...(failed.get(m) ?? []), path])
    }
  }
  const findings: DoctorFinding[] = [...failed].map(([m, paths]) => ({
    severity: 'error',
    code: 'secret_unresolved',
    message: `${paths.join(', ')}: ${m}`,
  }))
  const linearAuthOk = ![...failed.values()].flat().some((p) => p.startsWith(LINEAR_AUTH))
  return { findings, linearAuthOk }
}

async function signalFindings(
  config: Config,
  secret: (ref: string) => Promise<string>,
  httpFetch?: typeof fetch,
): Promise<DoctorFinding[]> {
  const s = config.notifications?.signal
  if (!s) return []
  try {
    await secret(s.api_key)
  } catch {
    return []
  }
  try {
    const api = signalApi(s, secret, { home: homedir(), ...(httpFetch ? { fetch: httpFetch } : {}) })
    const t = await resolveTarget(api, s.group)
    return [
      {
        severity: 'info',
        code: 'signal',
        message: `signal: reachable, account ${t.number}, group '${t.groupName}'`,
      },
    ]
  } catch (e) {
    if (e instanceof SignalApiError && e.unauthorized) {
      return [
        {
          severity: 'error',
          code: 'signal_auth',
          message: `signal: ${s.url} rejected the API key (http ${e.status})`,
          fix: 'check the secret behind notifications.signal.api_key',
        },
      ]
    }
    if (e instanceof SecretError) return []
    return [{ severity: 'error', code: 'signal_unreachable', message: `signal: ${message(e)}` }]
  }
}

type Checked = {
  findings: DoctorFinding[]
  host: CheckResult[]
  ops: ApplyOp[]
  workspace: string | null
  linear: DoctorLinear | null
}

async function check(deps: DoctorDeps): Promise<Checked> {
  const loaded = (deps.load ?? (() => loadConfig()))()
  if (!loaded.ok) {
    return {
      findings: loaded.errors.map((e) => ({ severity: 'error', code: 'config', message: formatError(e) })),
      host: [],
      ops: [],
      workspace: null,
      linear: null,
    }
  }
  const { config } = loaded
  const secret = (deps.secret ?? defaultSecret)(config)
  const findings: DoctorFinding[] = [
    { severity: 'info', code: 'config', message: `config loaded (${loaded.sources.join(', ')})` },
  ]
  const which = deps.which ?? ((bin: string) => Bun.which(bin))
  for (const [bin, why] of HOST_TOOLS) {
    if (!which(bin))
      findings.push({ severity: 'warning', code: 'host_tool', message: `${bin} not found on PATH: ${why}` })
  }
  const [host, secrets, signal] = await Promise.all([
    (deps.host ?? defaultHost)(config),
    secretFindings(config, secret),
    signalFindings(config, secret, deps.signalFetch),
  ])
  findings.push(...hostFindings(host), ...secrets.findings, ...signal)
  findings.push(
    ...host
      .filter((r) => r.ok)
      .map((r): DoctorFinding => ({ severity: 'info', code: 'host', message: `${r.name}: ${r.detail}` })),
  )
  if (!secrets.linearAuthOk) return { findings, host, ops: [], workspace: null, linear: null }

  const linear = (deps.linear ?? defaultLinear)(config, secret)
  let ws: LinearWorkspace
  let customViews: LinearCustomView[] | undefined
  try {
    ;[ws, customViews] = await Promise.all([linear.workspace(), linear.customViews().catch(() => undefined)])
  } catch (e) {
    findings.push({ severity: 'error', code: 'linear_unreadable', message: `linear: ${message(e)}` })
    return { findings, host, ops: [], workspace: null, linear: null }
  }
  const expected = expectedObjects(config, ws)
  const report = doctorReport(ws, doctorExpectations(expected))
  const plan = planApply(customViews ? { ...ws, customViews } : ws, expected)
  const reported = new Set(report.findings.map((f) => f.code))
  findings.push(...report.findings, ...plan.findings.filter((f) => !reported.has(f.code)))
  return { findings, host, ops: plan.ops, workspace: ws.organization.name, linear }
}

function sorted(findings: DoctorFinding[]): DoctorFinding[] {
  return findings.toSorted((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
}

function printFindings(findings: DoctorFinding[], io: Io): void {
  for (const f of findings) {
    io.out(`${f.severity}: ${f.message}`)
    if (f.fix) io.out(`  fix: ${f.fix}`)
  }
}

function printResult(result: ApplyResult, io: Io): void {
  for (const c of result.created) io.out(`${describeOp(c.op).replace(/^create /, 'created ')} (${c.id})`)
  if (result.failed) {
    io.out(`failed: ${describeOp(result.failed.op)}: ${result.failed.error}`)
    for (const op of result.pending) io.out(`not applied: ${describeOp(op)}`)
  }
}

export async function doctor(flags: DoctorFlags, deps: DoctorDeps, io: Io): Promise<number> {
  const checked = await check(deps)
  const findings = sorted(checked.findings)
  const ok = findings.every((f) => f.severity !== 'error')
  const { ops } = checked
  let result: ApplyResult | null = null
  const finish = (code: number) => {
    if (flags.json) io.out(JSON.stringify({ findings, host: checked.host, ops, result }))
    return code
  }

  if (!flags.json) printFindings(findings, io)
  if (!flags.apply) {
    if (!flags.json && ops.length > 0) io.out(`${ops.length} changes planned: run nightshift doctor --apply`)
    return finish(ok ? 0 : 1)
  }
  if (!checked.linear || checked.workspace === null) return finish(1)
  if (!flags.json) for (const op of ops) io.out(`plan: ${describeOp(op)}`)
  if (ops.length === 0) {
    if (!flags.json) io.out('nothing to apply')
    return finish(ok ? 0 : 1)
  }
  if (!flags.yes) {
    if (!(deps.interactive ?? (() => process.stdin.isTTY === true))()) {
      io.err('refusing to apply without confirmation (use --yes)')
      return finish(1)
    }
    const question = `apply ${ops.length} changes to workspace ${checked.workspace}? [y/N] `
    if (!(await (deps.confirm ?? ask)(question))) {
      if (!flags.json) io.out('nothing applied')
      return finish(ok ? 0 : 1)
    }
  }
  result = await checked.linear.apply(ops, { confirm: true })
  if (!flags.json) printResult(result, io)
  return finish(result.failed ? 1 : 0)
}
