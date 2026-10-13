/**
 * `meetsum-integrations` queue worker (docs/parity/m8.md, A5). Owner:
 * Package A. Started by worker/index.ts beside the bot worker and closed on
 * shutdown. Step 0: returns undefined (no worker).
 */
export type IntegrationWorkerHandle = { close(): Promise<void> }

export function startIntegrationWorker(): IntegrationWorkerHandle | undefined {
  return undefined
}
