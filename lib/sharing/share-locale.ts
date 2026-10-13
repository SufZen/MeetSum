import type { MeetingRecord } from "@/lib/meetings/repository"

export type ShareDocumentLocale = { lang: "he" | "en"; dir: "rtl" | "ltr" }

const HEBREW_CHARS = /[֐-׿]/

function isHebrewCode(value?: string | null) {
  const code = value?.trim().toLowerCase()

  return code === "he" || code === "iw" || Boolean(code?.startsWith("he-"))
}

/**
 * Document language/direction for a public share page: Hebrew meetings render
 * `lang="he" dir="rtl"`, everything else `lang="en" dir="ltr"`. Individual
 * text blocks still use `dir="auto"` so mixed Hebrew/English content is
 * bidi-correct either way.
 */
export function getShareDocumentLocale(
  meeting?: Pick<MeetingRecord, "language" | "languageMetadata" | "title"> & {
    summary?: { overview?: string }
  }
): ShareDocumentLocale {
  if (!meeting) return { lang: "en", dir: "ltr" }

  const primary = meeting.languageMetadata?.primaryLanguage
  const hebrew =
    isHebrewCode(primary) ||
    (!primary && isHebrewCode(meeting.language)) ||
    (!primary &&
      !isHebrewCode(meeting.language) &&
      meeting.language?.toLowerCase() === "mixed" &&
      HEBREW_CHARS.test(`${meeting.title} ${meeting.summary?.overview ?? ""}`))

  return hebrew ? { lang: "he", dir: "rtl" } : { lang: "en", dir: "ltr" }
}
