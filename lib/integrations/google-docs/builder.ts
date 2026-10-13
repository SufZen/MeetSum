/**
 * Google Docs body from a provider-neutral recap (docs/parity/m8.md, C2).
 * Owner: Package C. Pure.
 *
 * `buildGoogleDocRequests(recap, locale) → {title, requests}`:
 * - one `insertText` at index 1 with every paragraph (each ends with "\n");
 * - one `updateParagraphStyle` per paragraph: `namedStyleType`
 *   HEADING_1/HEADING_2/NORMAL_TEXT, plus `direction: RIGHT_TO_LEFT` and
 *   `alignment: START` on RTL (Hebrew) paragraphs only;
 * - `createParagraphBullets` per list (checkbox preset for action items,
 *   `BULLET_DISC_CIRCLE_SQUARE` for decisions and open questions);
 * - `updateTextStyle` for the MeetSum link and struck-through done items.
 * Indices are UTF-16 code units (JS string length) and include the trailing
 * newline, so Hebrew and emoji line up. Transcript direction follows each
 * segment's language, else the meeting's. Timecodes, dates and emails inside
 * RTL text are wrapped in U+2066…U+2069. Text only, never markup.
 */
import { isRtlLanguage, isolateLtr } from "@/lib/integrations/bidi"
import type { MeetingRecap } from "@/lib/integrations/recap"
import { getExportsMessages } from "@/lib/i18n/m8/exports"
import { getTaskTimeZone } from "@/lib/tasks/time-zone"

export type GoogleDocsLocale = "he" | "en"

type Range = { startIndex: number; endIndex: number }
type NamedStyle = "HEADING_1" | "HEADING_2" | "NORMAL_TEXT"
type TextStyle = { link?: { url: string }; strikethrough?: boolean }

export type GoogleDocRequest =
  | { insertText: { location: { index: number }; text: string } }
  | {
      updateParagraphStyle: {
        range: Range
        paragraphStyle: { namedStyleType: NamedStyle; direction?: "RIGHT_TO_LEFT"; alignment?: "START" }
        fields: string
      }
    }
  | { createParagraphBullets: { range: Range; bulletPreset: "BULLET_CHECKBOX" | "BULLET_DISC_CIRCLE_SQUARE" } }
  | { updateTextStyle: { range: Range; textStyle: TextStyle; fields: string } }
  | { deleteContentRange: { range: Range } }

type Span = { start: number; end: number; style: TextStyle }

type Paragraph = {
  text: string
  style: NamedStyle
  rtl: boolean
  bullet?: "checkbox" | "disc"
  spans?: Span[]
}

const LOCAL: Record<GoogleDocsLocale, { openInMeetSum: string }> = {
  en: { openInMeetSum: "Open in MeetSum" },
  he: { openInMeetSum: "פתיחה ב-MeetSum" },
}

export function googleDocsLocaleFor(language: string | undefined): GoogleDocsLocale {
  return isRtlLanguage(language) ? "he" : "en"
}

/** One line of plain text: no control characters, no paragraph breaks. */
function clean(value: string): string {
  return value
    .replace(/[\r\n\t\v\f]+/g, " ")
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, "")
    .trim()
}

function formatTimecode(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const mmss = `${String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`

  return hours ? `${hours}:${mmss}` : mmss
}

function formatDate(startedAt: string, locale: GoogleDocsLocale, env: NodeJS.ProcessEnv): string {
  const date = new Date(startedAt)

  if (Number.isNaN(date.getTime())) return startedAt

  return new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: getTaskTimeZone(env),
  }).format(date)
}

export function buildGoogleDocRequests(
  recap: MeetingRecap,
  locale: GoogleDocsLocale,
  options: { env?: NodeJS.ProcessEnv } = {}
): { title: string; requests: GoogleDocRequest[] } {
  const env = options.env ?? process.env
  const t = getExportsMessages(locale)
  const local = LOCAL[locale]
  const rtl = isRtlLanguage(recap.language)
  /** LTR token inside text of direction `paragraphRtl`. */
  const ltr = (token: string, paragraphRtl = rtl) => (paragraphRtl ? isolateLtr(token, "isolates") : token)
  const paragraphs: Paragraph[] = []
  const push = (paragraph: Paragraph) => {
    if (paragraph.text) paragraphs.push(paragraph)
  }
  const heading = (text: string, style: NamedStyle = "HEADING_2") => push({ text: clean(text), style, rtl })

  const title = clean(recap.title) || "MeetSum"

  heading(title, "HEADING_1")

  push({ text: `${t.exportLabelDate}: ${ltr(formatDate(recap.startedAt, locale, env))}`, style: "NORMAL_TEXT", rtl })

  if (recap.participants.length) {
    const people = recap.participants
      .map((participant) => (participant.email ? `${clean(participant.name)} (${ltr(participant.email)})` : clean(participant.name)))
      .join(", ")

    push({ text: `${t.exportHeadingParticipants}: ${people}`, style: "NORMAL_TEXT", rtl })
  }

  if (recap.overview) {
    heading(t.exportHeadingOverview)
    for (const line of recap.overview.split(/\n+/)) push({ text: clean(line), style: "NORMAL_TEXT", rtl })
  }

  if (recap.actionItems.length) {
    heading(t.exportHeadingActionItems)
    for (const item of recap.actionItems) {
      const itemTitle = clean(item.title)
      const details = [
        item.owner ? clean(item.owner) : undefined,
        item.dueDate ? `${t.exportLabelDue} ${ltr(item.dueDate)}` : undefined,
      ].filter(Boolean)

      push({
        text: details.length ? `${itemTitle} — ${details.join(" · ")}` : itemTitle,
        style: "NORMAL_TEXT",
        rtl,
        bullet: "checkbox",
        ...(item.status === "done" ? { spans: [{ start: 0, end: itemTitle.length, style: { strikethrough: true } }] } : {}),
      })
    }
  }

  const bulletList = (headingText: string, items: string[]) => {
    if (!items.length) return
    heading(headingText)
    for (const item of items) push({ text: clean(item), style: "NORMAL_TEXT", rtl, bullet: "disc" })
  }

  bulletList(t.exportHeadingDecisions, recap.decisions)
  bulletList(t.exportHeadingOpenQuestions, recap.openQuestions)

  const link = recap.links.share ?? recap.links.meeting

  if (link) {
    push({
      text: local.openInMeetSum,
      style: "NORMAL_TEXT",
      rtl,
      spans: [{ start: 0, end: local.openInMeetSum.length, style: { link: { url: link } } }],
    })
  }

  if (recap.transcript?.length) {
    heading(t.exportHeadingTranscript)
    for (const segment of recap.transcript) {
      const segmentRtl = isRtlLanguage(segment.language ?? recap.language)

      push({
        text: `${ltr(formatTimecode(segment.startMs), segmentRtl)} ${clean(segment.speaker)}: ${clean(segment.text)}`,
        style: "NORMAL_TEXT",
        rtl: segmentRtl,
      })
    }
  }

  // Lay the paragraphs out: index 1 is the first character of the body.
  const text = paragraphs.map((paragraph) => `${paragraph.text}\n`).join("")
  const requests: GoogleDocRequest[] = [{ insertText: { location: { index: 1 }, text } }]
  const ranges: Range[] = []
  let index = 1

  for (const paragraph of paragraphs) {
    const range = { startIndex: index, endIndex: index + paragraph.text.length + 1 }

    ranges.push(range)
    index = range.endIndex
    requests.push({
      updateParagraphStyle: {
        range,
        paragraphStyle: paragraph.rtl
          ? { namedStyleType: paragraph.style, direction: "RIGHT_TO_LEFT", alignment: "START" }
          : { namedStyleType: paragraph.style },
        fields: paragraph.rtl ? "namedStyleType,direction,alignment" : "namedStyleType",
      },
    })
  }

  // Contiguous list paragraphs of one kind become one bulleted list.
  for (let start = 0; start < paragraphs.length; ) {
    const kind = paragraphs[start].bullet

    if (!kind) {
      start += 1
      continue
    }

    let end = start

    while (end + 1 < paragraphs.length && paragraphs[end + 1].bullet === kind) end += 1
    requests.push({
      createParagraphBullets: {
        range: { startIndex: ranges[start].startIndex, endIndex: ranges[end].endIndex },
        bulletPreset: kind === "checkbox" ? "BULLET_CHECKBOX" : "BULLET_DISC_CIRCLE_SQUARE",
      },
    })
    start = end + 1
  }

  paragraphs.forEach((paragraph, position) => {
    for (const span of paragraph.spans ?? []) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: ranges[position].startIndex + span.start, endIndex: ranges[position].startIndex + span.end },
          textStyle: span.style,
          fields: Object.keys(span.style).join(","),
        },
      })
    }
  })

  return { title, requests }
}
