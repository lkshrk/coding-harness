import type { Ctx } from '../cli'
import { DOCTOR_USAGE } from '../doctor'
import { ENV_USAGE } from '../env'
import { ISSUE_USAGE } from '../issue-check'
import { ATTACH_USAGE, attach } from './attach'
import { answer, CONTROL_USAGE, cover, ingest, pause, retry, send, stop } from './control'
import { LOGS_USAGE, logs } from './logs'
import { QUESTIONS_USAGE, questions, TASKS_USAGE, tasks, WORKERS_USAGE, workers } from './read'
import { DIFF_USAGE, diff, TESTS_USAGE, tests } from './results'
import { SIGNAL_USAGE, signal } from './signal'
import { STATUS_USAGE, status } from './status'
import { STATUS_LINE_USAGE, statusLineCommand } from './statusline'
import { TAIL_USAGE, tail } from './tail'
import { WATCH_USAGE, watch } from './watch'

export type Command = (ctx: Ctx, args: string[]) => Promise<number> | number

export const COMMAND_HELP: Record<string, { usage: string; description: string }> = {
  help: { usage: 'ns help [<command>]', description: 'Show command usage.' },
  up: { usage: 'ns up', description: 'Install and start the supervisor service.' },
  down: { usage: 'ns down', description: 'Stop and remove the supervisor service.' },
  supervise: { usage: 'ns supervise', description: 'Run the supervisor in the foreground.' },
  doctor: { usage: DOCTOR_USAGE, description: 'Check configuration and host readiness.' },
  env: { usage: ENV_USAGE, description: 'Build or open a repository environment.' },
  issue: { usage: ISSUE_USAGE, description: 'Validate an issue description from a file or Linear.' },
  status: { usage: STATUS_USAGE, description: 'Show supervisor and gateway status.' },
  tasks: { usage: TASKS_USAGE, description: 'List managed issues.' },
  workers: { usage: WORKERS_USAGE, description: 'List active workers.' },
  logs: { usage: LOGS_USAGE, description: 'Show or follow supervisor events.' },
  questions: { usage: QUESTIONS_USAGE, description: 'List unanswered questions.' },
  diff: { usage: DIFF_USAGE, description: 'Show a run’s code changes.' },
  tests: { usage: TESTS_USAGE, description: 'Show gate and review results.' },
  tail: { usage: TAIL_USAGE, description: 'Follow a worker’s live output.' },
  watch: { usage: WATCH_USAGE, description: 'Watch workers in tmux panes.' },
  attach: { usage: ATTACH_USAGE, description: 'Attach to a worker or its sandbox.' },
  send: { usage: CONTROL_USAGE.send, description: 'Send a message to a worker.' },
  answer: { usage: CONTROL_USAGE.answer, description: 'Answer an issue’s open question.' },
  stop: { usage: CONTROL_USAGE.stop, description: 'Stop a run and hold its issue.' },
  retry: { usage: CONTROL_USAGE.retry, description: 'Dispatch another attempt.' },
  ingest: { usage: CONTROL_USAGE.ingest, description: 'Retry a failed closeout vault ingest.' },
  pause: { usage: CONTROL_USAGE.pause, description: 'Pause dispatch or hold an issue.' },
  resume: { usage: CONTROL_USAGE.resume, description: 'Resume dispatch or release a held issue.' },
  implement: { usage: CONTROL_USAGE.implement, description: 'Cover an issue for implementation.' },
  release: { usage: CONTROL_USAGE.release, description: 'Remove implementation coverage.' },
  signal: { usage: SIGNAL_USAGE, description: 'Test or pair Signal notifications.' },
  'status-line': { usage: STATUS_LINE_USAGE, description: 'Print a compact worker status line.' },
}

export const COMMANDS: Record<string, Command> = {
  status,
  tasks,
  workers,
  logs,
  questions,
  diff,
  tests,
  tail,
  watch,
  attach,
  send,
  answer,
  stop,
  retry,
  ingest,
  pause: (ctx, args) => pause(ctx, args, true),
  resume: (ctx, args) => pause(ctx, args, false),
  implement: (ctx, args) => cover(ctx, args, true),
  release: (ctx, args) => cover(ctx, args, false),
  signal,
  'status-line': statusLineCommand,
}
