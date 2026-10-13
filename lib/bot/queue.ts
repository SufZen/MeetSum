/**
 * The `meetsum-bot` BullMQ queue (M7 A7). Separate from the `meetsum` queue
 * so a long ASR job never delays a join; bot jobs write no `jobs` rows
 * (bot_sessions is the record). Step 0 stubs are no-ops.
 */

export const BOT_QUEUE_NAME = "meetsum-bot"

export const BOT_JOB_NAMES = [
  "bot.dispatch",
  "bot.consent",
  "bot.finalize",
  "bot.reconcile",
  "bot.retention",
] as const
export type BotJobName = (typeof BOT_JOB_NAMES)[number]

export type BotJobPayloads = {
  "bot.dispatch": { sessionId: string; rev: number; workspaceId: string }
  "bot.consent": { sessionId: string; workspaceId: string }
  "bot.finalize": { sessionId: string; workspaceId: string }
  /** `{workspaceId, resyncRules:true}` re-evaluates calendar rules for one workspace. */
  "bot.reconcile": { workspaceId?: string; resyncRules?: boolean }
  "bot.retention": { scheduled?: boolean }
}

export type BotJobOptions = {
  /** e.g. `bot.dispatch:<sessionId>:<rev>`, `bot.finalize:<sessionId>`. */
  jobId?: string
  delay?: number
  attempts?: number
}

export async function enqueueBotJob<Name extends BotJobName>(
  name: Name,
  payload: BotJobPayloads[Name],
  options: BotJobOptions = {}
): Promise<{ id?: string } | undefined> {
  void name
  void payload
  void options

  return undefined
}

export async function removeBotJob(jobId: string): Promise<void> {
  void jobId
}
