export type FrameKind =
  | 'data'
  | 'sync'
  | 'typing'
  | 'receipt'
  | 'edit'
  | 'pollCreate'
  | 'pollVote'
  | 'pollTerminate'
  | 'unknown'

export type GroupInfo = { groupId: string; groupName?: string; type?: string }

export type Quote = { id: number; author?: string; authorNumber?: string; authorUuid?: string; text?: string }

export type PollVote = {
  author?: string
  authorNumber?: string
  authorUuid?: string
  targetSentTimestamp: number
  optionIndexes: number[]
  voteCount?: number
}

export type DataMessage = {
  timestamp: number
  message: string | null
  groupInfo?: GroupInfo
  quote?: Quote
  pollCreate?: { question: string; allowMultiple: boolean; options: string[] }
  pollVote?: PollVote
  pollTerminate?: { targetSentTimestamp: number }
}

export type Envelope = {
  source?: string | null
  sourceNumber?: string | null
  sourceUuid?: string | null
  sourceName?: string | null
  timestamp: number
  dataMessage?: DataMessage | null
  syncMessage?: unknown
  typingMessage?: unknown
  receiptMessage?: unknown
  editMessage?: unknown
}

export type Frame = { envelope: Envelope; account?: string }

const GROUP_PREFIX = 'group.'

export function parseFrame(raw: string): Frame | null {
  try {
    const v = JSON.parse(raw) as Partial<Frame>
    return v && typeof v === 'object' && v.envelope && typeof v.envelope === 'object' ? (v as Frame) : null
  } catch {
    return null
  }
}

// Poll payloads nest inside dataMessage with a null body, so they must be tested before plain data.
export function frameKind(e: Envelope): FrameKind {
  const dm = e.dataMessage
  if (dm) {
    if (dm.pollVote) return 'pollVote'
    if (dm.pollCreate) return 'pollCreate'
    if (dm.pollTerminate) return 'pollTerminate'
    return 'data'
  }
  if (e.syncMessage) return 'sync'
  if (e.typingMessage) return 'typing'
  if (e.receiptMessage) return 'receipt'
  if (e.editMessage) return 'edit'
  return 'unknown'
}

export function groupRecipient(groupId: string): string {
  if (groupId === '' || groupId.startsWith(GROUP_PREFIX)) return groupId
  return GROUP_PREFIX + Buffer.from(groupId, 'utf8').toString('base64')
}

export function canonicalGroupId(id: string): string {
  if (!id.startsWith(GROUP_PREFIX)) return id
  const encoded = id.slice(GROUP_PREFIX.length)
  if (!/^[A-Za-z0-9+/]+=*$/.test(encoded)) return id
  return Buffer.from(encoded, 'base64').toString('utf8')
}

export function groupOf(e: Envelope): string | null {
  const id = e.dataMessage?.groupInfo?.groupId
  return id ? canonicalGroupId(id) : null
}

export function textOf(e: Envelope): string {
  return e.dataMessage?.message ?? ''
}
