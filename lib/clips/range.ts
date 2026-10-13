/**
 * Clip range resolution (M5 C1, pure and client-safe). A clip comes from an
 * explicit `[startMs, endMs)` range or from selected segments (their
 * min start / max end). The range must be at least 2 s, at most
 * `MEETSUM_CLIP_MAX_MS` (default 10 min) and inside the meeting.
 */
import { CLIP_DEFAULT_MAX_MS, CLIP_MIN_MS, type CreateClipInput } from "@/lib/clips/types"

export const CLIP_EXCERPT_MAX_CHARS = 1000
export const CLIP_TITLE_MAX_CHARS = 60
/** Longest title a user may set when renaming. */
export const CLIP_TITLE_LIMIT = 200

export type ClipErrorCode =
  | "invalid_range"
  | "too_short"
  | "too_long"
  | "out_of_bounds"
  | "unknown_segment"
  | "invalid_title"

export class ClipValidationError extends Error {
  constructor(readonly code: ClipErrorCode, message: string = code) {
    super(message)
    this.name = "ClipValidationError"
  }
}

export type ClipSegment = {
  id: string
  startMs: number
  endMs: number
  text: string
}

export type ResolvedClipRange = {
  startMs: number
  endMs: number
  segmentIds: string[]
  transcriptExcerpt?: string
  title: string
}

export function clipMaxMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.MEETSUM_CLIP_MAX_MS)

  return Number.isSafeInteger(parsed) && parsed >= CLIP_MIN_MS ? parsed : CLIP_DEFAULT_MAX_MS
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text)

  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : text
}

/** Single-line, trimmed title of at most `max` characters, or undefined. */
export function normalizeClipTitle(value: unknown, max = CLIP_TITLE_LIMIT): string | undefined {
  if (typeof value !== "string") return undefined

  const title = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()

  return title ? truncate(title, max) : undefined
}

/** `m:ss` / `h:mm:ss` (Western digits) for default titles and labels. */
export function formatClipClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, "0")

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`
}

function isMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

/** Segments overlapping `[startMs, endMs)`, in transcript order. */
export function segmentsInRange<T extends ClipSegment>(
  segments: readonly T[],
  startMs: number,
  endMs: number
): T[] {
  return segments.filter((segment) => segment.startMs < endMs && segment.endMs > startMs)
}

export function resolveClipRange(
  input: CreateClipInput,
  context: {
    segments: readonly ClipSegment[]
    /** Media/transcript duration when known. */
    durationMs?: number
    maxMs?: number
  }
): ResolvedClipRange {
  const maxMs = context.maxMs ?? CLIP_DEFAULT_MAX_MS
  let startMs: number
  let endMs: number

  if ("segmentIds" in input) {
    const wanted = new Set(input.segmentIds)

    if (!wanted.size) throw new ClipValidationError("unknown_segment")

    const picked = context.segments.filter((segment) => wanted.has(segment.id))

    if (picked.length !== wanted.size) throw new ClipValidationError("unknown_segment")

    startMs = Math.min(...picked.map((segment) => segment.startMs))
    endMs = Math.max(...picked.map((segment) => segment.endMs))
  } else {
    if (!isMs(input.startMs) || !isMs(input.endMs)) {
      throw new ClipValidationError("invalid_range")
    }

    startMs = Math.round(input.startMs)
    endMs = Math.round(input.endMs)
  }

  if (endMs <= startMs) throw new ClipValidationError("invalid_range")
  if (endMs - startMs < CLIP_MIN_MS) throw new ClipValidationError("too_short")
  if (endMs - startMs > maxMs) throw new ClipValidationError("too_long")

  const transcriptEnd = context.segments.reduce((max, segment) => Math.max(max, segment.endMs), 0)
  const bound = Math.max(context.durationMs ?? 0, transcriptEnd)

  if (bound > 0 && endMs > bound) throw new ClipValidationError("out_of_bounds")
  if (bound === 0) throw new ClipValidationError("out_of_bounds")

  const inRange = segmentsInRange(context.segments, startMs, endMs)
  const excerptText = inRange
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ")
  const transcriptExcerpt = excerptText ? truncate(excerptText, CLIP_EXCERPT_MAX_CHARS) : undefined
  const title =
    normalizeClipTitle("title" in input ? input.title : undefined) ??
    normalizeClipTitle(excerptText, CLIP_TITLE_MAX_CHARS) ??
    `${formatClipClock(startMs)}–${formatClipClock(endMs)}`

  return {
    startMs,
    endMs,
    segmentIds: inRange.map((segment) => segment.id),
    ...(transcriptExcerpt ? { transcriptExcerpt } : {}),
    title,
  }
}
