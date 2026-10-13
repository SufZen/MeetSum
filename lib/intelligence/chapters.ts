/**
 * Chapter normalization (A7). Deterministic: chapters with unknown start
 * aliases are dropped, starts are monotonic, the first chapter snaps to the
 * first segment, chapters closer than 2 minutes merge into the previous one,
 * the count is capped at 12 per hour, and `endMs` is the next chapter's start
 * (the last one ends at the transcript end).
 */
import { sha1Hex } from "@/lib/intelligence/normalize"
import type { Chapter } from "@/lib/intelligence/types"

import { resolveAlias } from "./citations"
import { transcriptEndMs, type PromptTranscript } from "./transcript-format"

export const MIN_CHAPTER_MS = 2 * 60 * 1000
export const MAX_CHAPTERS_PER_HOUR = 12

export type RawChapter = {
  title: string
  startRef: string
  summary?: string
  bullets?: string[]
}

function chapterId(startSegmentId: string, index: number): string {
  return `ch_${sha1Hex(`${startSegmentId}:${index}`).slice(0, 10)}`
}

export function normalizeChapters(
  raw: readonly RawChapter[],
  transcript: PromptTranscript,
  options: { endMs?: number } = {}
): Chapter[] {
  const segments = transcript.segments

  if (!segments.length) return []

  const first = segments[0]
  const endMs = Math.max(options.endMs ?? 0, transcriptEndMs(segments), first.startMs)
  const maxChapters = Math.max(1, Math.ceil(((endMs - first.startMs) / 3_600_000) * MAX_CHAPTERS_PER_HOUR))
  const resolved = raw
    .flatMap((chapter) => {
      const segment = resolveAlias(chapter.startRef, transcript)
      const title = chapter.title?.trim()

      return segment && title
        ? [
            {
              title,
              summary: chapter.summary?.trim() ?? "",
              bullets: (chapter.bullets ?? []).map((bullet) => bullet.trim()).filter(Boolean),
              segment,
            },
          ]
        : []
    })
    .sort((left, right) => left.segment.startMs - right.segment.startMs)

  if (!resolved.length) return []

  // The first chapter always starts at the transcript start.
  resolved[0] = { ...resolved[0], segment: first }

  const merged: typeof resolved = []

  for (const chapter of resolved) {
    const previous = merged[merged.length - 1]

    if (
      previous &&
      (chapter.segment.startMs - previous.segment.startMs < MIN_CHAPTER_MS ||
        merged.length >= maxChapters)
    ) {
      previous.bullets = [...previous.bullets, ...chapter.bullets]
      continue
    }
    merged.push({ ...chapter, bullets: [...chapter.bullets] })
  }

  return merged.map((chapter, index) => ({
    id: chapterId(chapter.segment.id, index),
    title: chapter.title,
    summary: chapter.summary,
    startMs: chapter.segment.startMs,
    endMs: merged[index + 1]?.segment.startMs ?? endMs,
    startSegmentId: chapter.segment.id,
    bullets: chapter.bullets,
  }))
}
