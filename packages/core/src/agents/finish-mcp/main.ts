import type { JsonSchema } from '../types'
import { finishServer, serve } from './server'

const path = process.env.NIGHTSHIFT_FINISH_PATH
if (!path) throw new Error('NIGHTSHIFT_FINISH_PATH is not set')
const output = process.env.NIGHTSHIFT_FINISH_OUTPUT
serve(finishServer({ path, ...(output ? { output: JSON.parse(output) as JsonSchema } : {}) }))
