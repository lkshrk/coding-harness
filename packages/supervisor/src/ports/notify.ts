export type NotificationKind = 'question' | 'blocked' | 'pr' | 'failed' | 'ci' | 'paused' | 'info'

export type Notification = {
  title: string
  issue?: string
  kind?: NotificationKind
  url?: string
  question?: { comment: string; text: string; options?: string[] }
  subject?: string
  context?: string[]
  action?: string
}

export interface Notifier {
  notify(n: Notification): Promise<'linear' | 'macos' | 'ntfy' | 'signal' | null>
}

export interface OutboxDirs {
  list(): string[]
  remove(run: string): void
}
