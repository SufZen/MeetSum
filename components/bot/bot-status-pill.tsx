import { botPillFor, type BotPill } from "@/components/bot/bot-ui-state"
import { StatusPill } from "@/components/ui/meeting-atoms"
import type { BotSessionSummary } from "@/lib/bot/types"
import type { Dictionary } from "@/lib/i18n/dictionaries"

/**
 * The bot's pill, exceptions only (botPillFor): joining, waiting to be
 * admitted, recording (the only `live` pill), failed/blocked with the
 * localized reason. Renders nothing for scheduled/completed/cancelled.
 */
export function BotStatusPill({
  session,
  pill,
  dictionary,
  className,
}: {
  session?: Pick<BotSessionSummary, "status" | "statusReason"> | null
  /** A precomputed pill (e.g. after inbox precedence). */
  pill?: BotPill | null
  dictionary: Dictionary
  className?: string
}) {
  const resolved = pill ?? (session ? botPillFor(session.status, session.statusReason) : null)

  if (!resolved) return null

  return (
    <StatusPill status={resolved.status} className={className}>
      {dictionary[resolved.labelKey]}
    </StatusPill>
  )
}
