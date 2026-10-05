--- BEGIN ISSUE ---
## Goal

Retry failed uploads up to three times with the configured backoff.

## Acceptance criteria

- [ ] A failed upload is retried at most three times.
- [ ] The delay between attempts comes from `config.upload.backoff`.
--- END ISSUE ---

--- BEGIN FILES ---
- src/upload.ts
--- END FILES ---

--- BEGIN OUTLINES ---
src/upload.ts
  export async function upload(file: Blob, opts?: UploadOptions): Promise<Result>
  function target(): Promise<string>
src/config.ts
  export type UploadConfig = { backoff: number[]; endpoint: string }
  export function loadConfig(): Config
src/send.ts
  export async function send(url: string, body: Blob): Promise<Result>
src/upload.test.ts
  test('uploads a file')
src/ui/progress.tsx
  export function Progress(props: { value: number }): JSX.Element
--- END OUTLINES ---

--- BEGIN PAGES ---
- wiki/retries.md (repo: app, paths: src/upload.ts, src/send.ts)
- wiki/ui-style.md (repo: app, paths: src/ui/**)
--- END PAGES ---
