import { findCandidateForPerson } from "@/lib/meetings/speakers/candidates"
import { sanitizeDisplayName } from "@/lib/meetings/speakers/names"
import type { SignalContext } from "@/lib/meetings/speakers/signals/context"
import type { MeetTimelineEntry } from "@/lib/meetings/speakers/types"

export const MEET_ALIGNMENT_MIN_SHARE = 0.5
export const MEET_ALIGNMENT_MIN_OVERLAP_MS = 20_000

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

/**
 * meet_alignment: the share of a speaker's talk time that overlaps a Meet
 * participant's transcript intervals. Share ≥ 0.5 and ≥ 20 s of overlap →
 * weight 0.6 + 0.4 × share.
 */
export function meetAlignmentSignal(context: SignalContext, timeline: readonly MeetTimelineEntry[]) {
  if (!timeline.length) return

  const byCandidate = new Map<string, MeetTimelineEntry[]>()

  for (const entry of timeline) {
    // Self-chosen display names: matched by sanitised name only (suggestion).
    const name = sanitizeDisplayName(entry.name)
    const candidate = name ? findCandidateForPerson(context.candidates, { name }) : undefined

    if (!candidate) continue

    const entries = byCandidate.get(candidate.key) ?? []

    entries.push(entry)
    byCandidate.set(candidate.key, entries)
  }

  for (const speaker of context.speakers) {
    const segments = context.segmentsBySpeaker.get(speaker.id) ?? []
    const talkMs = segments.reduce(
      (sum, segment) => sum + Math.max(0, segment.endMs - segment.startMs),
      0
    )

    if (!talkMs) continue

    for (const [candidateKey, entries] of byCandidate) {
      let overlap = 0

      for (const segment of segments) {
        for (const entry of entries) {
          overlap += overlapMs(segment.startMs, segment.endMs, entry.startMs, entry.endMs)
        }
      }

      const share = Math.min(1, overlap / talkMs)

      if (share >= MEET_ALIGNMENT_MIN_SHARE && overlap >= MEET_ALIGNMENT_MIN_OVERLAP_MS) {
        context.book.add(speaker.id, candidateKey, {
          kind: "meet_alignment",
          detail: `${Math.round(share * 100)}% aligned with the Meet transcript`,
          weight: Number((0.6 + 0.4 * share).toFixed(3)),
        })
      }
    }
  }
}
