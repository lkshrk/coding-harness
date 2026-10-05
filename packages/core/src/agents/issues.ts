import { formatPath, type SchemaIssue } from '../json-schema'

export { formatPath }

export function issueLines(issues: readonly SchemaIssue[], prefix: readonly PropertyKey[] = []): string[] {
  return issues.map((i) => {
    const path = formatPath([...prefix, ...i.path])
    return path ? `${path}: ${i.message}` : i.message
  })
}
