import { readFileSync } from 'node:fs'
import { type Config, expandHome } from '@nightshift/core'
import type { Db } from '../db'
import type { Notifier } from '../ports'
import { SignalApi, SignalLink } from './api'
import { type SignalActions, SignalInbox } from './inbox'
import { SignalNotifier } from './notifier'
import { SignalReceiver } from './receiver'
import { SignalStore, takePairing } from './store'

export { POLL_OPTIONS, resolveTarget, SignalApi, SignalApiError, SignalLink, type SignalTarget } from './api'
export * from './envelope'
export {
  BACK_MESSAGE,
  HELP,
  type Receiver,
  type SignalActions,
  SignalInbox,
  statusText,
} from './inbox'
export { messageText, SignalNotifier } from './notifier'
export { SignalReceiver } from './receiver'
export {
  PAIRING_TTL_MS,
  readSignalState,
  type SentMessage,
  type SignalState,
  SignalStore,
  startPairing,
  takePairing,
} from './store'

export type SignalSettings = NonNullable<Config['notifications']['signal']>

export function signalApi(
  s: SignalSettings,
  resolve: (ref: string) => Promise<string>,
  opts: { home: string; fetch?: typeof fetch },
): SignalApi {
  const ca = s.ca_bundle ? readFileSync(expandHome(s.ca_bundle, opts.home), 'utf8') : undefined
  return new SignalApi({
    url: s.url,
    apiKey: () => resolve(s.api_key),
    ...(ca ? { ca } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  })
}

export type SignalChannel = { notifier: Notifier; inbox: SignalInbox }

export function signalChannel(o: {
  settings: () => SignalSettings
  api: SignalApi
  db: Db
  stateDir: string
  fallback: Notifier
  actions: () => SignalActions
  out: (line: string) => void
}): SignalChannel {
  const link = new SignalLink(o.api, o.settings().group)
  const store = new SignalStore(o.db)
  const org = () =>
    o.db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get('linear_org')?.value
  const notifier = new SignalNotifier({
    link,
    store,
    fallback: o.fallback,
    out: o.out,
    healthy: () => ((o.settings().user ?? store.pairedUser()) ? 'ok' : 'unpaired'),
    issueUrl: (issue) => {
      const slug = org()
      return slug ? `https://linear.app/${slug}/issue/${issue}` : null
    },
  })
  const inbox = new SignalInbox({
    link,
    store,
    actions: o.actions,
    user: () => o.settings().user,
    takePairing: (code) => takePairing(o.stateDir, code),
    out: o.out,
    receiver: (hooks) =>
      new SignalReceiver({
        url: async () => o.api.receiveUrl((await link.target()).number),
        headers: () => o.api.headers(),
        ...(o.api.tls ? { tls: o.api.tls } : {}),
        ...hooks,
      }),
  })
  return { notifier, inbox }
}
