/**
 * Slack Block Kit recap (docs/parity/m8.md A9), pure. Owner: Package A.
 *
 * Limits: header plain_text ≤ 150, section mrkdwn ≤ 3000 (overview chunked),
 * ≤ 50 blocks with a "+N more" line, `text` fallback ≤ 3000.
 * Every user or AI string in a mrkdwn or `text` field is escaped (`& < >`),
 * which neutralizes `<!channel>`, `<@U…>` and `<url|label>` link injection
 * from content. The header is `plain_text`, which Slack neither parses for
 * mentions/links nor entity-decodes, so it is NOT escaped (an escaped
 * "Q&A" would show as "Q&amp;A"; VERIFY against Slack's Block Kit text
 * object docs). Text is truncated before escaping, and a truncation of
 * already-escaped text never cuts an entity in half.
 * Hebrew: Slack has no RTL, so every line, bullet and the header start
 * with RLM (never inside a URL); digits (dates, counts, durations) are
 * isolated with LRI…PDI.
 */
import { chunkText, isolateLtr, RLM } from "@/lib/integrations/bidi"
import type { MeetingRecap, MeetingRecapActionItem } from "@/lib/integrations/recap"

export const SLACK_MAX_BLOCKS = 50
export const SLACK_HEADER_MAX = 150
export const SLACK_SECTION_MAX = 3000
export const SLACK_TEXT_MAX = 3000

type Locale = "he" | "en"

const LABELS: Record<Locale, Record<string, string>> = {
  he: {
    recap: "סיכום",
    overview: "סקירה",
    actionItems: "משימות",
    decisions: "החלטות",
    openQuestions: "שאלות פתוחות",
    open: "פתיחה ב-MeetSum",
    share: "קישור שיתוף",
    participants: "משתתפים",
    minutes: "דק׳",
    more: "ועוד",
    due: "עד",
    newActionItem: "משימה חדשה",
  },
  en: {
    recap: "Recap",
    overview: "Overview",
    actionItems: "Action items",
    decisions: "Decisions",
    openQuestions: "Open questions",
    open: "Open in MeetSum",
    share: "Open share link",
    participants: "participants",
    minutes: "min",
    more: "more",
    due: "due",
    newActionItem: "New action item",
  },
}

export type SlackBlock = Record<string, unknown>
export type SlackMessage = { text: string; blocks: SlackBlock[] }

/** Escapes Slack control characters in user/AI text. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text

  const chars = Array.from(text)
  let result = ""

  for (const char of chars) {
    if (result.length + char.length > max - 1) break
    result += char
  }
  // Never leave half an entity (`&am`, `&l`…) at the cut.
  return `${result.replace(/&(?:a|am|amp|l|lt|g|gt)?$/, "")}…`
}

function line(text: string, rtl: boolean): string {
  return rtl ? `${RLM}${text}` : text
}

function isAbsoluteUrl(value: string | undefined): value is string {
  return Boolean(value && /^https?:\/\//i.test(value))
}

function formatDate(iso: string, locale: Locale, timeZone: string): string {
  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) return ""

  return new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date)
}

function itemLine(item: MeetingRecapActionItem, locale: Locale): string {
  const labels = LABELS[locale]
  const parts = [escapeSlack(item.title)]

  if (item.owner) parts.push(`— ${escapeSlack(item.owner)}`)
  if (item.dueDate) parts.push(`· ${labels.due} ${isolateLtr(escapeSlack(item.dueDate), "isolates")}`)
  return `• ${parts.join(" ")}`
}

/** `chunkText` over escaped text that never splits an `&amp;`/`&lt;`/`&gt;` entity. */
function chunkEscaped(text: string, max: number): string[] {
  const chunks = chunkText(text, max - 4)

  for (let index = 0; index < chunks.length - 1; index += 1) {
    const partial = /&(?:a|am|amp|l|lt|g|gt)?$/.exec(chunks[index])

    if (partial) {
      chunks[index] = chunks[index].slice(0, partial.index)
      chunks[index + 1] = `${partial[0]}${chunks[index + 1]}`
    }
  }
  return chunks.filter(Boolean)
}

/** Sections of `lines` under a bold label, each ≤ 3000 characters. */
function listSections(label: string, lines: string[], rtl: boolean): string[] {
  const heading = line(`*${label}*`, rtl)
  const sections: string[] = []
  let current = heading

  for (const raw of lines.flatMap((entry) => entry.split(/\r?\n/)).filter((entry) => entry.trim())) {
    for (const piece of chunkEscaped(raw, SLACK_SECTION_MAX - 2)) {
      const next = line(piece, rtl)

      if (current.length + 1 + next.length > SLACK_SECTION_MAX) {
        sections.push(current)
        current = next
      } else {
        current = `${current}\n${next}`
      }
    }
  }
  sections.push(current)
  return sections
}

function section(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text: truncate(text, SLACK_SECTION_MAX) } }
}

function buttons(recap: MeetingRecap, locale: Locale): SlackBlock | undefined {
  const labels = LABELS[locale]
  const elements: SlackBlock[] = []

  if (isAbsoluteUrl(recap.links.meeting)) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: labels.open, emoji: false },
      url: recap.links.meeting,
      action_id: "meetsum_open",
    })
  }
  if (isAbsoluteUrl(recap.links.share)) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: labels.share, emoji: false },
      url: recap.links.share,
      action_id: "meetsum_share",
    })
  }

  return elements.length ? { type: "actions", elements } : undefined
}

export type SlackMessageOptions = { locale: Locale; timeZone: string }

/** The full meeting recap message (`meeting.completed` / `summary.created`). */
export function buildSlackRecapMessage(recap: MeetingRecap, options: SlackMessageOptions): SlackMessage {
  const { locale, timeZone } = options
  const labels = LABELS[locale]
  const rtl = recap.dir === "rtl"
  const title = recap.title.trim() || labels.recap
  // plain_text: not escaped (Slack shows it literally).
  const headerText = truncate(line(`${labels.recap}: ${title}`, rtl), SLACK_HEADER_MAX)
  // The mrkdwn `text` fallback: truncated first, then escaped.
  const fallbackHeader = escapeSlack(headerText)
  const contextParts = [
    isolateLtr(formatDate(recap.startedAt, locale, timeZone), "isolates"),
    ...(recap.durationMs ? [`${isolateLtr(String(Math.max(1, Math.round(recap.durationMs / 60_000))), "isolates")} ${labels.minutes}`] : []),
    ...(recap.participants.length ? [`${isolateLtr(String(recap.participants.length), "isolates")} ${labels.participants}`] : []),
  ].filter(Boolean)

  const head: SlackBlock[] = [{ type: "header", text: { type: "plain_text", text: headerText, emoji: false } }]

  if (contextParts.length) {
    head.push({ type: "context", elements: [{ type: "mrkdwn", text: line(contextParts.join(" · "), rtl) }] })
  }

  const body: SlackBlock[] = []

  if (recap.overview) {
    for (const text of listSections(labels.overview, [escapeSlack(recap.overview)], rtl)) body.push(section(text))
  }
  if (recap.actionItems.length) {
    for (const text of listSections(labels.actionItems, recap.actionItems.map((item) => itemLine(item, locale)), rtl)) {
      body.push(section(text))
    }
  }
  if (recap.decisions.length) {
    for (const text of listSections(labels.decisions, recap.decisions.map((decision) => `• ${escapeSlack(decision)}`), rtl)) {
      body.push(section(text))
    }
  }
  if (recap.openQuestions.length) {
    for (const text of listSections(labels.openQuestions, recap.openQuestions.map((question) => `• ${escapeSlack(question)}`), rtl)) {
      body.push(section(text))
    }
  }

  const tail = buttons(recap, locale)
  const room = SLACK_MAX_BLOCKS - head.length - (tail ? 1 : 0)
  let blocks: SlackBlock[]

  if (body.length > room) {
    const kept = body.slice(0, room - 1)
    const hidden = body.length - kept.length

    blocks = [
      ...head,
      ...kept,
      { type: "context", elements: [{ type: "mrkdwn", text: line(`+${isolateLtr(String(hidden), "isolates")} ${labels.more}`, rtl) }] },
    ]
  } else {
    blocks = [...head, ...body]
  }
  if (tail) blocks.push(tail)

  const fallback = [
    fallbackHeader,
    ...(recap.overview ? escapeSlack(recap.overview).split(/\r?\n/).filter((entry) => entry.trim()).map((entry) => line(entry, rtl)) : []),
  ]

  if (isAbsoluteUrl(recap.links.meeting)) fallback.push(recap.links.meeting)

  return { text: truncate(fallback.join("\n"), SLACK_TEXT_MAX), blocks }
}

/** One action item (`action_item.created`). */
export function buildSlackActionItemMessage(
  recap: MeetingRecap,
  item: MeetingRecapActionItem,
  options: SlackMessageOptions
): SlackMessage {
  const labels = LABELS[options.locale]
  const rtl = recap.dir === "rtl"
  const text = `${line(`*${labels.newActionItem}* · ${escapeSlack(recap.title)}`, rtl)}\n${line(itemLine(item, options.locale), rtl)}`
  const blocks: SlackBlock[] = [section(text)]
  const tail = buttons(recap, options.locale)

  if (tail) blocks.push(tail)

  return { text: truncate(text, SLACK_TEXT_MAX), blocks }
}
