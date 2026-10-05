import { describe, expect, test } from 'bun:test'
import { parseSse, type SseMessage } from './sse'

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk))
      c.close()
    },
  })
}

async function collect(chunks: string[]): Promise<SseMessage[]> {
  const out: SseMessage[] = []
  for await (const m of parseSse(stream(chunks))) out.push(m)
  return out
}

describe('parseSse', () => {
  test('parses messages split across chunks and skips comments', async () => {
    expect(
      await collect(['data: {"a"', ':1}\n\n: heartbeat\n\n', 'event: x\nid: 7\r\ndata: 2\r\n\r\n']),
    ).toEqual([{ data: '{"a":1}' }, { data: '2', event: 'x', id: '7' }])
  })

  test('joins multi-line data and drops an unterminated tail', async () => {
    expect(await collect(['data: a\ndata: b\n\ndata: c'])).toEqual([{ data: 'a\nb' }])
  })
})
