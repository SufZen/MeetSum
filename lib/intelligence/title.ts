/**
 * AI auto-title policy (A8). `autoTitleMode`:
 * - `generic_only` (default): replace generic, filename-like or untitled
 *   titles, and earlier AI titles; never a user title.
 * - `always`: replace anything except a user title.
 * - `off`: never.
 */
import { TITLE_MAX_CHARS } from "@/lib/ai/templates/schema"

export type AutoTitleMode = "generic_only" | "always" | "off"

export type TitleSource = "source" | "ai" | "user"

const GENERIC_TITLE_PATTERNS: RegExp[] = [
  /^$/,
  /^untitled( meeting| recording)?( \d+)?$/i,
  /^(new |my )?(meeting|recording|call|audio( recording)?|voice memo|conversation)( \d+)?$/i,
  /^(zoom|teams|google meet|meet|webex) (meeting|call|recording)$/i,
  /^(personal meeting room|instant meeting)$/i,
  /^פגישה( חדשה)?( ללא (שם|כותרת))?( \d+)?$/,
  /^פגישה ללא (שם|כותרת)$/,
  /^ללא (שם|כותרת)$/,
  /^(הקלטה|שיחה|הקלטה קולית)( חדשה)?( \d+)?$/,
  /\.(mp3|mp4|m4a|wav|webm|ogg|oga|opus|aac|flac|mov|mkv|avi)$/i,
  /^(gmt|zoom_)\d{6,}/i,
  /^(audio|video|rec|recording|meeting)[ _-]?\d[\d _:.-]*$/i,
  /^[\d _:./-]+$/,
  /^(meeting|recording|פגישה|הקלטה)[ _-]+\d{1,4}[./-]\d{1,2}[./-]\d{1,4}([ _T]\d{1,2}[:.]\d{2}([:.]\d{2})?)?$/i,
]

/** True for empty, placeholder, filename or date-only titles. */
export function isGenericMeetingTitle(title: string | undefined | null): boolean {
  const normalized = (title ?? "").replace(/\s+/g, " ").trim()

  return GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function normalizeAutoTitleMode(value: unknown): AutoTitleMode {
  return value === "always" || value === "off" ? value : "generic_only"
}

export function shouldApplyAiTitle(options: {
  mode: AutoTitleMode
  title: string | undefined
  titleSource?: TitleSource | string
}): boolean {
  if (options.mode === "off" || options.titleSource === "user") return false
  if (options.mode === "always") return true
  return options.titleSource === "ai" || isGenericMeetingTitle(options.title)
}

/** Trims quotes/whitespace and cuts to 60 chars at a word boundary. */
export function cleanAiTitle(title: string): string {
  const cleaned = title
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'\u201c\u201d\u05f3\u05f4]+|["'\u201c\u201d\u05f3\u05f4]+$/g, "")
    .trim()

  if (cleaned.length <= TITLE_MAX_CHARS) return cleaned

  const cut = cleaned.slice(0, TITLE_MAX_CHARS)
  const boundary = cut.lastIndexOf(" ")

  return (boundary > TITLE_MAX_CHARS / 2 ? cut.slice(0, boundary) : cut).trim()
}
