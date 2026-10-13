import type { SignalContext } from "@/lib/meetings/speakers/signals/context"

export const ORGANIZER_OWNER_WEIGHT = 0.2

/** Sources recorded on the owner's own device (the owner usually talks most). */
const OWNER_RECORDED_SOURCES = new Set(["desktop_recorder", "pwa_recorder"])

/**
 * organizer_owner: for recordings made on the owner's device, +0.2 for the
 * organizer participant on the top talker. A boost only — never enough alone.
 */
export function organizerOwnerSignal(context: SignalContext, meetingSource?: string) {
  if (!meetingSource || !OWNER_RECORDED_SOURCES.has(meetingSource)) return

  const organizer = context.candidates.find(
    (candidate) => candidate.isParticipant && candidate.role === "organizer"
  )
  const topTalker = [...context.speakers].sort((a, b) => b.talkTimeMs - a.talkTimeMs)[0]

  if (!organizer || !topTalker) return

  context.book.add(topTalker.id, organizer.key, {
    kind: "organizer_owner",
    detail: "Top talker on the organizer's own recording",
    weight: ORGANIZER_OWNER_WEIGHT,
  })
}
