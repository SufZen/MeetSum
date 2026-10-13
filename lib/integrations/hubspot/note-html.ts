/**
 * HubSpot meeting/note body (docs/parity/m8.md, B3). Every piece of meeting
 * text is HTML-escaped (no markup from content ever reaches HubSpot). Hebrew
 * bodies are wrapped in `<div dir="rtl">` and every text line starts with an
 * RLM, a fallback in case HubSpot's sanitizer strips `dir`. Capped at 60,000
 * characters (`hs_meeting_body` / `hs_note_body` limit; verify against
 * current HubSpot docs).
 */
import { RLM } from "@/lib/integrations/bidi"
import { formatRecapDueDate, type MeetingRecap } from "@/lib/integrations/recap"

export const HUBSPOT_BODY_MAX = 60_000

const STRINGS = {
  he: {
    summary: "סיכום",
    decisions: "החלטות",
    actionItems: "משימות",
    openQuestions: "שאלות פתוחות",
    open: "פתיחה ב-MeetSum",
    owner: "אחראי",
    due: "יעד",
    truncated: "(קוצר)",
  },
  en: {
    summary: "Summary",
    decisions: "Decisions",
    actionItems: "Action items",
    openQuestions: "Open questions",
    open: "Open in MeetSum",
    owner: "Owner",
    due: "Due",
    truncated: "(truncated)",
  },
} as const

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Only absolute https URLs become links; anything else is dropped. */
function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)

    return parsed.protocol === "https:" ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

export function renderHubspotNoteHtml(recap: MeetingRecap): string {
  const rtl = recap.dir === "rtl"
  const t = rtl ? STRINGS.he : STRINGS.en
  const text = (value: string) => escapeHtml(rtl ? `${RLM}${value}` : value)
  const lines = (value: string) =>
    value
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(text)
      .join("<br>")
  const open = rtl ? '<div dir="rtl">' : "<div>"
  const close = "</div>"
  const href = safeHref(recap.links.meeting) ?? safeHref(recap.links.share)
  const tail = href ? `<p><a href="${escapeHtml(href)}">${text(t.open)}</a></p>` : ""
  const budget = HUBSPOT_BODY_MAX - open.length - close.length - tail.length - 64
  const parts: string[] = []
  let used = 0
  let truncated = false

  const push = (html: string): boolean => {
    if (truncated) return false
    if (used + html.length > budget) {
      truncated = true
      return false
    }
    parts.push(html)
    used += html.length
    return true
  }

  const list = (heading: string, items: string[]) => {
    if (!items.length) return
    if (!push(`<h3>${text(heading)}</h3><ul>`)) return
    for (const item of items) {
      if (!push(`<li>${lines(item)}</li>`)) break
    }
    parts.push("</ul>")
  }

  if (recap.overview) {
    if (push(`<h3>${text(t.summary)}</h3>`)) {
      const paragraph = `<p>${lines(recap.overview)}</p>`

      if (!push(paragraph)) {
        // A very long overview is cut on a safe boundary (after escaping, never inside an entity).
        const room = Math.max(0, budget - used - 8)
        const cut = paragraph.slice(0, room).replace(/&[a-z#0-9]*$/i, "").replace(/<[^>]*$/, "")

        parts.push(`${cut}</p>`)
        used += cut.length + 4
      }
    }
  }

  list(t.decisions, recap.decisions)
  list(
    t.actionItems,
    recap.actionItems.map((item) =>
      [item.title, item.owner ? `${t.owner}: ${item.owner}` : "", item.dueDate ? `${t.due}: ${formatRecapDueDate(item.dueDate, rtl ? "he" : "en")}` : ""]
        .filter(Boolean)
        .join(" · ")
    )
  )
  list(t.openQuestions, recap.openQuestions)

  if (truncated) parts.push(`<p>${text(t.truncated)}</p>`)

  return `${open}${parts.join("")}${tail}${close}`
}
