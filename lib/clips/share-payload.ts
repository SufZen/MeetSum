/**
 * Public clip share payload (M5 C2). Like M4's `buildSharePayload`, the clip
 * page renders ONLY what this pure builder returns: the clip's title,
 * duration, excerpt and render state, and the meeting's title, start time
 * and language. Never ids (clip, meeting, workspace, segments, users),
 * emails, storage keys or render errors.
 */
import type { ClipShareView, MeetingClip } from "@/lib/clips/types"

export type ClipSharePayload = {
  title: string
  durationMs: number
  /** Offset of the clip inside the meeting (display only). */
  offsetMs: number
  excerpt?: string
  /** The audio object exists; otherwise the page shows "preparing". */
  audioReady: boolean
  meetingTitle: string
  startedAt: string
  language: string
  lang: "he" | "en"
  dir: "rtl" | "ltr"
  /** Direction of meeting text: from the known language, `auto` only when unknown/mixed. */
  textDir: "rtl" | "ltr" | "auto"
}

function isHebrew(language: string | undefined) {
  const code = language?.trim().toLowerCase()

  return code === "he" || code === "iw" || Boolean(code?.startsWith("he-"))
}

/** Document language / direction from the meeting's known language. */
export function clipShareLocale(language: string | undefined): { lang: "he" | "en"; dir: "rtl" | "ltr" } {
  return isHebrew(language) ? { lang: "he", dir: "rtl" } : { lang: "en", dir: "ltr" }
}

const LTR_LANGUAGES = new Set(["en", "pt", "es", "it"])

export function clipTextDir(language: string | undefined): "rtl" | "ltr" | "auto" {
  if (isHebrew(language)) return "rtl"

  const base = language?.trim().toLowerCase().split("-")[0]

  return base && LTR_LANGUAGES.has(base) ? "ltr" : "auto"
}

export function clipAudioReady(clip: Pick<MeetingClip, "renderStatus" | "storageKey">): boolean {
  return clip.renderStatus === "ready" && Boolean(clip.storageKey)
}

export function buildClipSharePayload(view: ClipShareView): ClipSharePayload {
  const { clip, meeting } = view

  return {
    title: clip.title,
    durationMs: Math.max(0, clip.endMs - clip.startMs),
    offsetMs: clip.startMs,
    ...(clip.transcriptExcerpt ? { excerpt: clip.transcriptExcerpt } : {}),
    audioReady: clipAudioReady(clip),
    meetingTitle: meeting.title,
    startedAt: meeting.startedAt,
    language: meeting.language,
    ...clipShareLocale(meeting.language),
    textDir: clipTextDir(meeting.language),
  }
}
