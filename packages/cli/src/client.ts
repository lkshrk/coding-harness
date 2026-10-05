import type { ErrorResponse } from '@nightshift/supervisor'

export const SUPERVISOR_DOWN = 'supervisor not running (nightshift up)'

const EXIT_BY_CODE: Record<string, number> = { bad_request: 2, not_found: 4, refused: 5 }

export class ControlFailure extends Error {
  override name = 'ControlFailure'

  constructor(
    readonly exit: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

export type ControlFn = <T = unknown>(
  path: string,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
) => Promise<T>

export const control: ControlFn = async <T>(
  path: string,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
) => {
  let res: Response
  try {
    res = await fetch(`http://localhost${route}`, {
      unix: path,
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
  } catch {
    throw new ControlFailure(3, SUPERVISOR_DOWN)
  }
  const text = await res.text()
  let value: unknown
  try {
    value = text ? JSON.parse(text) : undefined
  } catch {
    throw new ControlFailure(1, `supervisor returned invalid JSON (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const err = (value as ErrorResponse | undefined)?.error
    throw new ControlFailure(
      EXIT_BY_CODE[err?.code ?? ''] ?? 1,
      err?.message ?? `HTTP ${res.status}`,
      err?.code,
    )
  }
  return value as T
}
