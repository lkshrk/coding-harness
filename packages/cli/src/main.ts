#!/usr/bin/env bun
import { run } from './run'

process.exitCode = await run(process.argv.slice(2), {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
})
