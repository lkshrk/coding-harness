import { shellQuote } from './remote'

export const WATCH_SESSION = 'ns-watch'
export const WATCH_SOCKET = 'nightshift'
export const WORKERS_WINDOW = 'workers'
export const MANAGER_WINDOW = 'manager'
export const ATTACH_KEY = 'a'

export type TmuxRunner = (args: string[]) => { exitCode: number; stdout: string; stderr: string }

export type Pane = { id: string; window: string; run: string; issue: string; title: string; dead: boolean }

export const shellLine = (argv: string[]) => argv.map(shellQuote).join(' ')

// A private tmux server keeps the key binding and global options away from the user's own sessions.
export function tmuxArgs(...args: string[]): string[] {
  return ['tmux', '-L', WATCH_SOCKET, ...args]
}

export class Tmux {
  constructor(private readonly run: TmuxRunner) {}

  private ok(args: string[]): string {
    const r = this.run(tmuxArgs(...args))
    if (r.exitCode !== 0) throw new Error(`tmux ${args.join(' ')}: ${r.stderr.trim()}`)
    return r.stdout
  }

  hasSession(): boolean {
    return this.run(tmuxArgs('has-session', '-t', WATCH_SESSION)).exitCode === 0
  }

  createSession(manager: string[], swap: string[]): void {
    this.ok(['new-session', '-d', '-s', WATCH_SESSION, '-n', MANAGER_WINDOW, shellLine(manager)])
    this.ok(['set-option', '-wg', 'remain-on-exit', 'on'])
    this.ok(['set-option', '-wg', 'pane-border-status', 'top'])
    this.ok([
      'set-option',
      '-wg',
      'pane-border-format',
      ' #{pane_title}#{?#{@ns-issue}, │ #(ns status-line --tmux #{@ns-issue}),} ',
    ])
    this.ok(['set-option', '-g', 'status-interval', '5'])
    this.ok(['set-option', '-g', 'status-style', 'bg=#1a1b26,fg=#a9b1d6'])
    this.ok(['set-option', '-g', 'status-left', '#[fg=#1a1b26,bg=#7aa2f7,bold] #S #[default] '])
    this.ok(['set-option', '-g', 'window-status-current-style', 'fg=#7aa2f7,bold'])
    this.ok(['set-option', '-g', 'pane-border-style', 'fg=#3b4261'])
    this.ok(['set-option', '-g', 'pane-active-border-style', 'fg=#7aa2f7'])
    this.ok(['set-option', '-g', 'status-right-length', '160'])
    this.ok(['set-option', '-g', 'status-right', ' #(ns status-line --tmux) '])
    this.ok(['bind-key', ATTACH_KEY, 'run-shell', `${shellLine(swap)} '#{pane_id}'`])
  }

  attachCommand(): string[] {
    return tmuxArgs('attach-session', '-t', WATCH_SESSION)
  }

  panes(): Pane[] {
    const format = '#{pane_id}\t#{window_id}\t#{@ns-run}\t#{@ns-issue}\t#{pane_title}\t#{pane_dead}'
    return this.ok(['list-panes', '-s', '-t', WATCH_SESSION, '-F', format])
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [id, window, run, issue, title, dead] = l.split('\t')
        return {
          id: id as string,
          window: window as string,
          run: run ?? '',
          issue: issue ?? '',
          title: title ?? '',
          dead: dead === '1',
        }
      })
  }

  addPane(o: { run: string; issue: string; command: string[]; maxPanes: number }): string {
    const workers = this.panes().filter((p) => p.run !== '')
    const byWindow = new Map<string, number>()
    for (const p of workers) byWindow.set(p.window, (byWindow.get(p.window) ?? 0) + 1)
    const window = [...byWindow.entries()].find(([, n]) => n < o.maxPanes)?.[0]
    const id = window
      ? this.ok(['split-window', '-d', '-t', window, '-P', '-F', '#{pane_id}', shellLine(o.command)]).trim()
      : this.ok([
          'new-window',
          '-d',
          '-t',
          WATCH_SESSION,
          '-n',
          WORKERS_WINDOW,
          '-P',
          '-F',
          '#{pane_id}',
          shellLine(o.command),
        ]).trim()
    this.ok(['set-option', '-p', '-t', id, '@ns-run', o.run])
    this.ok(['set-option', '-p', '-t', id, '@ns-issue', o.issue])
    this.ok(['select-pane', '-t', id, '-T', o.issue])
    this.ok(['select-layout', '-t', id, 'tiled'])
    return id
  }

  title(pane: string, title: string): void {
    this.ok(['select-pane', '-t', pane, '-T', title])
  }

  issueOf(pane: string): string {
    return this.ok(['show-options', '-p', '-v', '-t', pane, '@ns-issue']).trim()
  }

  respawn(pane: string, command: string[]): void {
    this.ok(['respawn-pane', '-k', '-t', pane, shellLine(command)])
  }

  selectWorkers(): void {
    this.run(tmuxArgs('select-window', '-t', `${WATCH_SESSION}:${WORKERS_WINDOW}`))
  }
}
