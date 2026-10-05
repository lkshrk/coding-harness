export type SseMessage = { event?: string; id?: string; data: string }

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder()
  let buffer = ''
  let current: { event?: string; id?: string; data: string[] } = { data: [] }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.search(/\r?\n/)
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(buffer[newline] === '\r' ? newline + 2 : newline + 1)
      newline = buffer.search(/\r?\n/)
      if (line === '') {
        if (current.data.length > 0) {
          yield {
            data: current.data.join('\n'),
            ...(current.event ? { event: current.event } : {}),
            ...(current.id ? { id: current.id } : {}),
          }
        }
        current = { data: [] }
        continue
      }
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'data') current.data.push(value)
      else if (field === 'event') current.event = value
      else if (field === 'id') current.id = value
    }
  }
}
