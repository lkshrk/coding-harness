import type { Lease, LeaseStore } from '../state/leases'
import { isTerminal, type Run } from '../state/runs'
import type { SupervisorRuntime } from './runtime'

export type LeasesPeers = { recoverRun: (run: Run) => Promise<void> }

export class Leases {
  constructor(
    private readonly rt: SupervisorRuntime,
    private readonly store: LeaseStore,
    private readonly instanceId: string,
    private readonly peers: LeasesPeers,
  ) {}

  renewLeases(): void {
    for (const run of this.rt.runs.active()) {
      if (this.store.get(run.issue)?.holder === this.instanceId) this.store.renew(run.issue)
    }
  }

  async expireLease(lease: Lease): Promise<void> {
    this.rt.log.append({
      type: 'LEASE_EXPIRED',
      issue: lease.issue,
      data: { holder: lease.holder, expires: lease.expiresAt },
    })
    const run = this.rt.runs.get(lease.run)
    if (run && !isTerminal(run.state)) {
      await this.peers.recoverRun(run)
    } else {
      this.store.release(lease.issue)
    }
  }

  takeLease(run: Run): void {
    this.store.release(run.issue)
    this.store.acquire(run.issue, run.id)
    this.leaseEvent('LEASE_ACQUIRED', run.issue)
  }

  releaseLease(issue: string): void {
    const lease = this.store.get(issue)
    if (!lease) return
    this.store.release(issue)
    this.rt.log.append({
      type: 'LEASE_RELEASED',
      issue,
      data: { holder: lease.holder, expires: lease.expiresAt },
    })
  }

  leaseEvent(type: 'LEASE_ACQUIRED', issue: string): void {
    const lease = this.store.get(issue)
    if (lease) this.rt.log.append({ type, issue, data: { holder: lease.holder, expires: lease.expiresAt } })
  }
}
