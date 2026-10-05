import { expect, test } from 'bun:test'
import { COMMAND_HELP, COMMANDS } from './index'

test('all registered and built-in commands have usage and one-line descriptions', () => {
  expect(Object.keys(COMMAND_HELP).sort()).toEqual(
    [...Object.keys(COMMANDS), 'help', 'up', 'down', 'supervise', 'doctor', 'env'].sort(),
  )
  for (const [command, entry] of Object.entries(COMMAND_HELP)) {
    expect(entry.usage).toContain(`ns ${command}`)
    expect(entry.description.length).toBeGreaterThan(0)
    expect(entry.description).not.toContain('\n')
  }
})
