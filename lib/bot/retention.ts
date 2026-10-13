import { getBotConfig } from "@/lib/bot/config"
import { redactBotError } from "@/lib/bot/redact"
import { getBotSessionStore, type BotSessionStore } from "@/lib/bot/store"
import { getBotProvider } from "@/lib/bot/vexa/client"
import { VexaError, type BotProvider } from "@/lib/bot/vexa/types"

/**
 * Daily Vexa artifact purge (M7 B6): once our copy is imported (or the
 * session ended without a recording) and MEETSUM_VEXA_ARTIFACT_RETENTION_HOURS
 * have passed, `DELETE /meetings/{id}` erases Vexa's transcript and
 * recording objects. 2xx/404 → `vexa_purged_at`; 409 (bot still in the
 * meeting) → skipped for the next run. bot_events payloads are pruned to
 * `{}` after 30 days. Terminal sessions lose any leftover `passcode_enc`.
 */

export const BOT_EVENT_PAYLOAD_RETENTION_DAYS = 30

export async function runBotRetention(
  options: {
    provider?: BotProvider
    now?: Date
    store?: BotSessionStore
    retentionHours?: number
  } = {}
): Promise<{ purged: number; skipped: number; prunedEvents: number; passcodesCleared: number }> {
  const store = options.store ?? getBotSessionStore()
  const now = options.now ?? new Date()
  const hours = options.retentionHours ?? getBotConfig().artifactRetentionHours
  const cutoff = new Date(now.getTime() - hours * 3_600_000)
  const candidates = await store.listPurgeable(cutoff)
  let provider = options.provider
  let purged = 0
  let skipped = 0

  for (const session of candidates) {
    if (!session.vexaMeetingId) continue

    provider ??= getBotProvider()

    try {
      await provider.deleteMeeting(session.vexaMeetingId)
    } catch (error) {
      if (!(error instanceof VexaError && error.kind === "not_found")) {
        if (!(error instanceof VexaError && error.kind === "conflict")) {
          console.warn("[bot] retention delete failed", redactBotError(error))
        }
        skipped += 1
        continue
      }
    }

    // The workspace comes from the row itself (system job).
    await store.update(
      session.id,
      { vexaPurgedAt: now.toISOString() },
      { workspaceId: session.workspaceId }
    )
    purged += 1
  }

  const prunedEvents = await store.pruneEventPayloads(
    new Date(now.getTime() - BOT_EVENT_PAYLOAD_RETENTION_DAYS * 86_400_000)
  )

  // Meeting passcodes are only needed to dispatch; never keep them past the end.
  const passcodesCleared = await store.clearTerminalPasscodes()

  return { purged, skipped, prunedEvents, passcodesCleared }
}
