/**
 * Comment / reaction target validation against one meeting (M5 C3; pure).
 * A target is valid only when it exists in that meeting right now:
 * - `segment`: a transcript segment id
 * - `summary_item` / `chapter`: an id in the current (normalized) intelligence
 * - `action_item`: an action item of the meeting
 * - `clip`: a live clip of the meeting (ids supplied by the caller)
 * - `meeting`: the meeting itself
 */
import type { CommentAnchor, CommentTargetType, ReactionTargetType } from "@/lib/comments/types"
import { normalizeIntelligence } from "@/lib/intelligence/normalize"
import type { MeetingRecord } from "@/lib/meetings/repository"

export const ANCHOR_QUOTE_MAX_CHARS = 200

export type TargetIndex = {
  segments: Map<string, { startMs: number; text: string }>
  summaryItems: Map<string, string>
  chapters: Map<string, { startMs: number; title: string }>
  actionItems: Map<string, { title: string; startMs?: number }>
  clips: Map<string, { startMs: number; title: string }>
  meetingId: string
}

export type TargetMeeting = Pick<MeetingRecord, "id" | "transcript" | "intelligence" | "summary">

function quote(text: string): string {
  const chars = Array.from(text.trim())

  return chars.length > ANCHOR_QUOTE_MAX_CHARS
    ? `${chars.slice(0, ANCHOR_QUOTE_MAX_CHARS - 1).join("")}…`
    : chars.join("")
}

export function buildTargetIndex(
  meeting: TargetMeeting,
  clips: readonly { id: string; startMs: number; title: string }[] = []
): TargetIndex {
  const intelligence = meeting.intelligence ? normalizeIntelligence(meeting.intelligence) : undefined
  const actionItems = new Map<string, { title: string; startMs?: number }>()

  for (const item of [...(meeting.summary?.actionItems ?? []), ...(intelligence?.actionItems ?? [])]) {
    if (item?.id && !actionItems.has(item.id)) {
      actionItems.set(item.id, { title: item.title, startMs: item.sourceStartMs })
    }
  }

  return {
    meetingId: meeting.id,
    segments: new Map(
      (meeting.transcript ?? []).map((segment) => [
        segment.id,
        { startMs: segment.startMs, text: segment.text },
      ])
    ),
    summaryItems: new Map((intelligence?.items ?? []).map((item) => [item.id, item.text])),
    chapters: new Map(
      (intelligence?.chapters ?? []).map((chapter) => [
        chapter.id,
        { startMs: chapter.startMs, title: chapter.title },
      ])
    ),
    actionItems,
    clips: new Map(clips.map((clip) => [clip.id, { startMs: clip.startMs, title: clip.title }])),
  }
}

/**
 * The anchor stored with a new comment on a valid target, or undefined when
 * the target does not exist in this meeting.
 */
export function anchorForTarget(
  index: TargetIndex,
  targetType: CommentTargetType | ReactionTargetType,
  targetId: string
): CommentAnchor | undefined {
  switch (targetType) {
    case "segment": {
      const segment = index.segments.get(targetId)

      return segment ? { startMs: segment.startMs, quote: quote(segment.text) } : undefined
    }
    case "summary_item": {
      const text = index.summaryItems.get(targetId)

      return text !== undefined ? { quote: quote(text) } : undefined
    }
    case "chapter": {
      const chapter = index.chapters.get(targetId)

      return chapter ? { startMs: chapter.startMs, quote: quote(chapter.title) } : undefined
    }
    case "action_item": {
      const item = index.actionItems.get(targetId)

      return item
        ? { ...(item.startMs !== undefined ? { startMs: item.startMs } : {}), quote: quote(item.title) }
        : undefined
    }
    case "clip": {
      const clip = index.clips.get(targetId)

      return clip ? { startMs: clip.startMs, quote: quote(clip.title) } : undefined
    }
    case "meeting":
      return targetId === index.meetingId ? {} : undefined
    default:
      return undefined
  }
}

export function targetExists(
  index: TargetIndex,
  targetType: CommentTargetType | ReactionTargetType,
  targetId: string
): boolean {
  return anchorForTarget(index, targetType, targetId) !== undefined
}

/**
 * Segment containing `startMs`, else the nearest one before it, else the
 * first one: where a segment comment belongs after re-transcription.
 */
export function segmentForTime(
  segments: readonly { id: string; startMs: number; endMs: number }[],
  startMs: number
): string | undefined {
  let containing: string | undefined
  let before: { id: string; startMs: number } | undefined

  for (const segment of segments) {
    if (segment.startMs <= startMs && segment.endMs > startMs) {
      if (!containing) containing = segment.id
    }
    if (segment.startMs <= startMs && (!before || segment.startMs >= before.startMs)) {
      before = segment
    }
  }

  return containing ?? before?.id ?? segments[0]?.id
}
