/**
 * Speaker colour palette (M4, client-safe, pure).
 *
 * Cadence v2.0 defines eight matched-lightness speaker hues (`--spk-1…8`);
 * the design system overrides the older 10-colour plan. Colours are assigned
 * in order of first speech and shared by the player lanes, transcript rows,
 * talk-time bars and the speaker mapping panel (same ordering as
 * `speakerColors` in components/speaker-display.ts).
 */
import type { MeetingSpeaker } from "@/lib/meetings/repository"

export type SpeakerColorIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export const SPEAKER_PALETTE_SIZE = 8

export const SPEAKER_PALETTE: readonly string[] = Array.from(
  { length: SPEAKER_PALETTE_SIZE },
  (_, index) => `var(--spk-${index + 1})`
)

export function colorIndexFor(position: number): SpeakerColorIndex {
  return ((((position % SPEAKER_PALETTE_SIZE) + SPEAKER_PALETTE_SIZE) % SPEAKER_PALETTE_SIZE) +
    1) as SpeakerColorIndex
}

/** CSS colour of a palette slot, e.g. `var(--spk-3)`. */
export function speakerColorVar(color: SpeakerColorIndex): string {
  return SPEAKER_PALETTE[color - 1]
}

const GENERIC_LABEL = /^Speaker (\d+)$/

function genericNumber(label: string): number {
  const match = GENERIC_LABEL.exec(label.trim())

  return match ? Number(match[1]) : 0
}

/** Speakers ordered by first speech, then generic number, then label. */
export function orderByFirstSpeech<T extends Pick<MeetingSpeaker, "id" | "label" | "firstStartMs">>(
  speakers: readonly T[]
): T[] {
  return [...speakers].sort((a, b) => {
    const first =
      (a.firstStartMs ?? Number.MAX_SAFE_INTEGER) - (b.firstStartMs ?? Number.MAX_SAFE_INTEGER)

    if (first) return first

    return genericNumber(a.label) - genericNumber(b.label) || a.label.localeCompare(b.label)
  })
}

/** Speaker id → palette slot. */
export function assignSpeakerColors(
  speakers: readonly Pick<MeetingSpeaker, "id" | "label" | "firstStartMs">[]
): Map<string, SpeakerColorIndex> {
  return new Map(
    orderByFirstSpeech(speakers).map((speaker, position) => [speaker.id, colorIndexFor(position)])
  )
}
