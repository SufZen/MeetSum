"use client"

import { useMemo } from "react"

import {
  resolveSegmentSpeaker,
  speakerColors,
  type SegmentSpeaker,
} from "@/components/speaker-display"
import type { MeetingParticipant, MeetingSpeaker } from "@/lib/meetings/repository"

export type SpeakerDirectory = {
  forSegment: (segment: { speaker: string; speakerId?: string }) => SegmentSpeaker
}

/**
 * Resolves display name, initials, colour (by first speech) and unconfirmed
 * state for transcript rows, lanes and talk time, memoized per segment key.
 */
export function useSpeakerDirectory(
  speakers: readonly MeetingSpeaker[],
  participants: readonly MeetingParticipant[],
  genericLabel: string
): SpeakerDirectory {
  return useMemo(() => {
    const list = [...speakers]
    const colors = speakerColors(list)
    const cache = new Map<string, SegmentSpeaker>()

    return {
      forSegment: (segment) => {
        const key = segment.speakerId ?? `label:${segment.speaker}`
        let resolved = cache.get(key)

        if (!resolved) {
          resolved = resolveSegmentSpeaker(segment, list, [...participants], colors, genericLabel)
          cache.set(key, resolved)
        }

        return resolved
      },
    }
  }, [genericLabel, participants, speakers])
}
