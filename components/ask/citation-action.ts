/**
 * What a citation chip does when clicked (docs/parity/m6.md, D2). Pure.
 *
 * - Same meeting with a player: seek to the resolved segment (M4
 *   `resolveCitation`); a citation that doesn't resolve isn't rendered.
 * - Another meeting (or no player): navigate to the deep link
 *   `/<locale>?meeting=<id>&t=<sec>`.
 * - `unavailable` (the meeting is no longer visible): a disabled chip.
 * - Nothing to point at (no meeting, no time and no segment): not rendered.
 */
import type { AskCitation } from "@/lib/ask/types"
import type { ResolvedCitation } from "@/lib/player/citations"
import { buildSegmentLink } from "@/lib/player/deep-link"

export type CitationAction =
  | { kind: "seek"; startMs: number; segmentId: string }
  | { kind: "navigate"; href: string }
  | { kind: "disabled" }
  | { kind: "hidden" }

export function citationAction(
  citation: Pick<AskCitation, "meetingId" | "segmentId" | "startMs" | "unavailable">,
  context: {
    locale: string
    /** The meeting whose player is mounted, if any. */
    currentMeetingId?: string
    playerAvailable: boolean
    resolve: (source: { segmentId?: string; startMs?: number }) => ResolvedCitation | undefined
  }
): CitationAction {
  if (citation.unavailable) return { kind: "disabled" }
  if (!citation.meetingId) return { kind: "hidden" }

  const startMs =
    typeof citation.startMs === "number" && Number.isFinite(citation.startMs) && citation.startMs >= 0
      ? citation.startMs
      : undefined

  if (context.playerAvailable && context.currentMeetingId === citation.meetingId) {
    const resolved = context.resolve({ segmentId: citation.segmentId, startMs })

    return resolved ? { kind: "seek", startMs: resolved.startMs, segmentId: resolved.segmentId } : { kind: "hidden" }
  }

  if (startMs === undefined && !citation.segmentId) return { kind: "hidden" }

  return {
    kind: "navigate",
    href: buildSegmentLink({ locale: context.locale, meetingId: citation.meetingId, ms: startMs ?? 0 }),
  }
}
