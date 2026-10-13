/**
 * M8 integrations queue (docs/parity/m8.md, A4/A5). A separate BullMQ queue
 * (as M7 does with `meetsum-bot`) so a long ASR job never delays a delivery.
 * Owned by Package A.
 */
export const INTEGRATIONS_QUEUE = "meetsum-integrations"

export const INTEGRATION_JOB_NAMES = [
  /** jobId `integration.dispatch:<eventId>`: rules → delivery rows. */
  "integration.dispatch",
  /** jobId `<deliveryId>`: one provider push. */
  "integration.deliver",
  /** Provider `jobs` (e.g. Outlook calendarSync) per connection. */
  "integration.job",
  /** Repeatable, every minute: enqueues due per-connection jobs. */
  "integration.tick",
  /** Daily: expired OAuth states, old deliveries. */
  "integration.sweep",
] as const

export type IntegrationJobName = (typeof INTEGRATION_JOB_NAMES)[number]
