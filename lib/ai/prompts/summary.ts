/**
 * Core summary instructions (A5), written in the output language (Hebrew
 * first). They come after the cached prefix, so they may contain the
 * meeting date anchor, participants and template sections.
 */
import { modelSections } from "@/lib/ai/templates/schema"
import type { SectionSpec, SummaryTemplateDef } from "@/lib/ai/templates/types"

export const DEFAULT_TIME_ZONE = "Asia/Jerusalem"

const HE_WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"]
const EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/** `{date: "DD.MM.YYYY", weekday}` of an ISO datetime in a time zone. */
export function meetingDateParts(iso: string, timeZone = DEFAULT_TIME_ZONE) {
  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) return undefined

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  ) as Record<string, string>
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday)

  return {
    date: `${parts.day}.${parts.month}.${parts.year}`,
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    weekdayIndex,
  }
}

/** "יום חמישי, 15.10.2026" / "Thursday, 15.10.2026". */
export function formatMeetingDate(iso: string, lang: string, timeZone = DEFAULT_TIME_ZONE) {
  const parts = meetingDateParts(iso, timeZone)

  if (!parts) return undefined
  return lang === "he"
    ? `יום ${HE_WEEKDAYS[parts.weekdayIndex]}, ${parts.date}`
    : `${EN_WEEKDAYS[parts.weekdayIndex]}, ${parts.date}`
}

export type SummaryPromptInput = {
  language: string
  template: SummaryTemplateDef
  meetingTitle: string
  /** ISO datetime the meeting started (relative-date anchor). */
  startedAt: string
  timeZone?: string
  /** Resolved participant / speaker names. */
  participants: string[]
  /** Transcript duration, for the chapter target. */
  durationMs: number
}

function sectionInstructions(section: SectionSpec, lang: string): string {
  return section.localizedInstructions?.[lang === "he" ? "he" : "en"] ?? section.instructions
}

function sectionLines(sections: SectionSpec[], lang: string): string[] {
  return sections.map((section) => {
    const title = section.title[lang === "he" ? "he" : "en"]
    const limit = section.maxItems
      ? lang === "he"
        ? ` (עד ${section.maxItems} פריטים)`
        : ` (at most ${section.maxItems} items)`
      : ""
    const required = section.required ? (lang === "he" ? " [חובה]" : " [required]") : ""

    return `- ${section.key} — ${title} (${section.kind})${limit}${required}: ${sectionInstructions(section, lang)}`
  })
}

/** Chapter count target: 3–12 per hour, at least 1. */
export function chapterTarget(durationMs: number) {
  const hours = Math.max(durationMs / 3_600_000, 1 / 60)

  return {
    min: Math.max(1, Math.min(3, Math.round(hours * 3))),
    max: Math.max(1, Math.ceil(hours * 12)),
  }
}

export function buildSummaryInstructions(input: SummaryPromptInput): string {
  const lang = input.language
  const sections = modelSections(input.template)
  const date = formatMeetingDate(input.startedAt, lang, input.timeZone) ?? input.startedAt
  const participants = input.participants.filter(Boolean)
  const chapters = chapterTarget(input.durationMs)
  const addendum = input.template.promptAddendum[lang === "he" ? "he" : "en"].trim()

  if (lang === "he") {
    return [
      `כותרת הפגישה: ${input.meetingTitle}`,
      `תאריך הפגישה: ${date}. יש לחשב תאריכים יחסיים ("מחר", "יום ראשון") ביחס לתאריך זה.`,
      participants.length ? `משתתפים: ${participants.join(", ")}` : "",
      addendum,
      "יש להחזיר את השדות הבאים:",
      "- overview: תקציר של 3–5 משפטים.",
      "- decisions, risks, openQuestions, commitments, nextSteps: פריטים קצרים. לכל פריט text ו-refs (מזהי הקטעים שמהם הוא נלקח, למשל [\"s12\"]).",
      sections.length
        ? ["- sections: סעיפי התבנית, לכל סעיף key, text (לסעיף פסקה) ו-items עם refs:", ...sectionLines(sections, lang)].join("\n")
        : "- sections: רשימה ריקה.",
      `- chapters: ${chapters.min}–${chapters.max} פרקים לפי סדר הזמן, כל פרק לפחות 2 דקות. לכל פרק title, startRef (מזהה הקטע הראשון), summary ו-bullets.`,
      "- actionItems: רק משימות אמיתיות (התחייבויות, הקצאות, בקשות מפורשות). לכל משימה title בלשון ניטרלית, ownerText (השם כפי שנאמר), ownerIsSourceSpeaker (true כשהדובר לוקח את המשימה על עצמו, למשל \"אני אשלח\"), dueText (ניסוח המועד כפי שנאמר, למשל \"עד יום ראשון\"), dueDate (YYYY-MM-DD רק כשהמועד ברור), priority, confidence, sourceRef, sourceQuote (ציטוט מדויק מהקטע) ו-kind.",
      "- followUpDraft: טיוטת מייל המשך קצרה.",
      "אסור לצטט מזהה קטע שלא מופיע בתמלול. ציטוט חייב להופיע מילה במילה בקטע שמצוין.",
    ]
      .filter(Boolean)
      .join("\n")
  }

  return [
    `Meeting title: ${input.meetingTitle}`,
    `Meeting date: ${date}. Resolve relative dates ("tomorrow", "Sunday") against this date.`,
    participants.length ? `Participants: ${participants.join(", ")}` : "",
    addendum,
    "Return these fields:",
    "- overview: a 3–5 sentence overview.",
    "- decisions, risks, openQuestions, commitments, nextSteps: short items, each with text and refs (the segment ids it comes from, e.g. [\"s12\"]).",
    sections.length
      ? ["- sections: the template sections, each with key, text (for paragraph sections) and items with refs:", ...sectionLines(sections, lang)].join("\n")
      : "- sections: an empty list.",
    `- chapters: ${chapters.min}–${chapters.max} chapters in time order, each at least 2 minutes long, with title, startRef (first segment id), summary and bullets.`,
    "- actionItems: real tasks only (commitments, assignments, explicit requests). Each with title, ownerText (name as spoken), ownerIsSourceSpeaker (true when the speaker takes the task, e.g. \"I'll send it\"), dueText (the due phrase as spoken), dueDate (YYYY-MM-DD only when clear), priority, confidence, sourceRef, sourceQuote (exact quote from that segment) and kind.",
    "- followUpDraft: a short follow-up email draft.",
    "Never cite a segment id that is not in the transcript. A quote must appear verbatim in the segment it cites.",
  ]
    .filter(Boolean)
    .join("\n")
}

/** Corrective line for the language-check retry. */
export function languageRetryInstruction(lang: string): string {
  return lang === "he"
    ? "חשוב: הפלט הקודם לא נכתב בעברית. יש לכתוב את כל השדות בעברית בלבד (מונחים טכניים ושמות מוצרים נשארים באותיות לטיניות)."
    : "Important: the previous output was not in English. Write every field in English only (quotes may stay in their original language)."
}
