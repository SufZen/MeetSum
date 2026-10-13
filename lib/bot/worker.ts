/**
 * The bot BullMQ worker (M7 A7), started from worker/index.ts next to the
 * main worker. Returns undefined when the bot feature is disabled.
 */

export type BotWorkerHandle = { close(): Promise<void> }

/** Step 0 stub: never starts a worker. */
export function startBotWorker(): BotWorkerHandle | undefined {
  return undefined
}
