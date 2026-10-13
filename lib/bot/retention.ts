import type { BotProvider } from "@/lib/bot/vexa/types"

/**
 * Daily Vexa artifact purge (M7 B6): DELETE /meetings/{id} after
 * MEETSUM_VEXA_ARTIFACT_RETENTION_HOURS, and bot_events payload pruning after
 * 30 days. Step 0 stub throws.
 */
export async function runBotRetention(
  options: { provider?: BotProvider; now?: Date } = {}
): Promise<{ purged: number; skipped: number; prunedEvents: number }> {
  void options
  throw new Error("runBotRetention not implemented (M7)")
}
