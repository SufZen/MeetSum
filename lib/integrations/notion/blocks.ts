/**
 * Notion page body from a provider-neutral recap (docs/parity/m8.md, C1).
 * Owner: Package C. Pure.
 *
 * Limits (Notion API, version 2022-06-28):
 * - every `rich_text[].text.content` ≤ 2000 characters (`chunkText`);
 * - ≤ 100 `rich_text` items per block (longer text spills into more blocks);
 * - ≤ 100 children per create/append request (`batchNotionChildren`).
 *
 * Hebrew: Notion has no direction property; it lays a block out from its
 * first strong character. So in an RTL meeting every line starts with
 * Hebrew or an RLM (`rtlLine`), and transcript timecodes go at the END of
 * the line, LRM-isolated (`טקסט — ‎00:12‎`), so line order and reading
 * order stay intact. To verify in a real workspace on the first live run
 * (runbook step), since this is empirical Notion behaviour.
 *
 * Text only: content is never interpreted as markup.
 */
import { chunkText, isolateLtr, isRtlLanguage, rtlLine } from "@/lib/integrations/bidi"
import { formatRecapDueDate, type MeetingRecap } from "@/lib/integrations/recap"
import { getExportsMessages, type ExportsMessages } from "@/lib/i18n/m8/exports"

export const NOTION_MAX_TEXT_LENGTH = 2000
export const NOTION_MAX_RICH_TEXT_ITEMS = 100
export const NOTION_MAX_CHILDREN_PER_REQUEST = 100
export const DEFAULT_NOTION_MAX_TRANSCRIPT_BLOCKS = 900

export type NotionRichText = {
  type: "text"
  text: { content: string; link?: { url: string } | null }
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean; color?: string }
}

export type NotionBlock = {
  object: "block"
  type: string
  [key: string]: unknown
}

export type NotionLocale = "he" | "en"

export type BuildNotionPageOptions = {
  maxTranscriptBlocks?: number
}

const LOCAL: Record<NotionLocale, { truncated: (count: number) => string; openInMeetSum: string }> = {
  en: {
    truncated: (count) => `Transcript truncated: ${count} more segments are in MeetSum.`,
    openInMeetSum: "Open in MeetSum",
  },
  he: {
    truncated: (count) => `התמליל קוצר: עוד ${count} קטעים זמינים ב-MeetSum.`,
    openInMeetSum: "פתיחה ב-MeetSum",
  },
}

export function notionLocaleFor(language: string | undefined): NotionLocale {
  return isRtlLanguage(language) ? "he" : "en"
}

/** `MEETSUM_NOTION_MAX_TRANSCRIPT_BLOCKS` (default 900, at least 1). */
export function notionMaxTranscriptBlocks(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.MEETSUM_NOTION_MAX_TRANSCRIPT_BLOCKS)

  return Number.isInteger(value) && value > 0 ? value : DEFAULT_NOTION_MAX_TRANSCRIPT_BLOCKS
}

/** Text → rich_text items of ≤ 2000 characters each. */
export function notionRichText(text: string, link?: string): NotionRichText[] {
  return chunkText(text, NOTION_MAX_TEXT_LENGTH).map((content) => ({
    type: "text",
    text: link ? { content, link: { url: link } } : { content },
  }))
}

/**
 * One logical block of text → one or more blocks of `type`, each with at
 * most 100 rich_text items (a 300k-character overview becomes 2 blocks).
 */
function textBlocks(type: string, text: string, extra: Record<string, unknown> = {}): NotionBlock[] {
  const items = notionRichText(text)
  const blocks: NotionBlock[] = []

  for (let index = 0; index < Math.max(items.length, 1); index += NOTION_MAX_RICH_TEXT_ITEMS) {
    blocks.push({
      object: "block",
      type,
      [type]: { rich_text: items.slice(index, index + NOTION_MAX_RICH_TEXT_ITEMS), ...extra },
    })
  }

  return blocks
}

function divider(): NotionBlock {
  return { object: "block", type: "divider", divider: {} }
}

function formatTimecode(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`

  return hours ? `${hours}:${mmss}` : mmss
}

/**
 * Builds the page body. `properties` are built separately
 * (`buildNotionProperties`) because they depend on the database schema.
 */
export function buildNotionPage(
  recap: MeetingRecap,
  locale: NotionLocale,
  options: BuildNotionPageOptions = {}
): { children: NotionBlock[] } {
  const t: ExportsMessages = getExportsMessages(locale)
  const local = LOCAL[locale]
  const meetingRtl = isRtlLanguage(recap.language)
  /** RTL-safe line(s) for the meeting's direction. */
  const line = (text: string, rtl = meetingRtl) => (rtl ? rtlLine(text) : text)
  const children: NotionBlock[] = []
  const heading = (text: string) => children.push(...textBlocks("heading_2", line(text)))

  if (recap.overview) {
    heading(t.exportHeadingOverview)
    for (const paragraph of recap.overview.split(/\n{2,}/)) {
      const trimmed = paragraph.trim()

      if (trimmed) children.push(...textBlocks("paragraph", line(trimmed)))
    }
  }

  if (recap.actionItems.length) {
    heading(t.exportHeadingActionItems)
    for (const item of recap.actionItems) {
      const details = [
        item.owner,
        item.dueDate
          ? `${t.exportLabelDue} ${meetingRtl ? isolateLtr(formatRecapDueDate(item.dueDate, locale), "marks") : formatRecapDueDate(item.dueDate, locale)}`
          : undefined,
      ].filter(Boolean)
      const text = details.length ? `${item.title} — ${details.join(" · ")}` : item.title

      children.push(...textBlocks("to_do", line(text), { checked: item.status === "done" }))
    }
  }

  if (recap.decisions.length) {
    heading(t.exportHeadingDecisions)
    for (const decision of recap.decisions) children.push(...textBlocks("bulleted_list_item", line(decision)))
  }

  if (recap.openQuestions.length) {
    heading(t.exportHeadingOpenQuestions)
    for (const question of recap.openQuestions) children.push(...textBlocks("bulleted_list_item", line(question)))
  }

  const meetingLink = recap.links.share ?? recap.links.meeting

  if (meetingLink) {
    children.push(divider())
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          ...(meetingRtl ? notionRichText(line("‏")) : []),
          ...notionRichText(local.openInMeetSum, meetingLink),
        ],
      },
    })
  }

  if (recap.transcript?.length) {
    const max = options.maxTranscriptBlocks ?? notionMaxTranscriptBlocks()
    const shown = recap.transcript.slice(0, max)

    children.push(divider())
    heading(t.exportHeadingTranscript)
    for (const segment of shown) {
      const rtl = isRtlLanguage(segment.language ?? recap.language)
      const timecode = formatTimecode(segment.startMs)
      // Timecode last: the line still starts with the speaker (Hebrew or RLM).
      const text = `${segment.speaker}: ${segment.text} — ${rtl ? isolateLtr(timecode, "marks") : timecode}`

      children.push(...textBlocks("paragraph", line(text, rtl)))
    }

    if (recap.transcript.length > shown.length) {
      children.push(
        ...textBlocks("callout", line(local.truncated(recap.transcript.length - shown.length)), {
          icon: { type: "emoji", emoji: "✂️" },
        })
      )
    }
  }

  return { children }
}

/** Children in request-sized batches (≤ 100 each), order preserved. */
export function batchNotionChildren(children: NotionBlock[]): NotionBlock[][] {
  const batches: NotionBlock[][] = []

  for (let index = 0; index < children.length; index += NOTION_MAX_CHILDREN_PER_REQUEST) {
    batches.push(children.slice(index, index + NOTION_MAX_CHILDREN_PER_REQUEST))
  }

  return batches
}
