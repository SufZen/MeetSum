/**
 * Meeting recap email (docs/parity/m8.md A10). Owner: Package A.
 *
 * - Subject `סיכום פגישה: <title>` / `Meeting recap: <title>` (RFC 2047 is
 *   applied by the MIME builder).
 * - HTML: `<html lang dir>`, `dir="rtl"` for Hebrew, logical CSS only
 *   (`text-align:start`), table layout for Gmail/Outlook. Every text is
 *   HTML-escaped; owners in `<bdi>`, emails, dates and times in
 *   `<bdi dir="ltr">`.
 * - Plain text: RLM-prefixed lines for Hebrew.
 * - Footer: why the recipient got it, plus the unsubscribe link.
 * - Headers: List-Unsubscribe (+ RFC 8058 Post), Auto-Submitted,
 *   X-MeetSum-Meeting.
 */
import type { EmailMessage } from "@/lib/email/types"
import { formatDate as formatDateValue } from "@/lib/i18n/format"
import { RLM } from "@/lib/integrations/bidi"
import { recapStrings } from "@/lib/integrations/email-recap/strings"
import { formatRecapDueDate, type MeetingRecap } from "@/lib/integrations/recap"

export type MeetingRecapEmailInput = {
  to: string
  locale: "he" | "en"
  recap: MeetingRecap
  workspaceName: string
  /** App link (members only). */
  appUrl?: string
  /** Existing share link (non-members, when the rule allows it). */
  shareUrl?: string
  unsubscribeUrl: string
  timeZone: string
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

function formatDate(iso: string, locale: "he" | "en", timeZone: string): string {
  return formatDateValue(iso, { locale, timeZone }, "dateTimeLong")
}

function safeHref(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? escapeHtml(url) : undefined
}

export function buildMeetingRecapEmail(input: MeetingRecapEmailInput): EmailMessage {
  const { recap, locale } = input
  const strings = recapStrings(locale)
  const rtl = locale === "he"
  const dir = rtl ? "rtl" : "ltr"
  const title = recap.title.trim() || "MeetSum"
  const subject = fill(strings.recapSubject, { title: title.replace(/[\r\n]+/g, " ") })
  const date = formatDate(recap.startedAt, locale, input.timeZone)
  const appHref = safeHref(input.appUrl)
  const shareHref = safeHref(input.shareUrl)
  const unsubscribeHref = safeHref(input.unsubscribeUrl)

  // ---- HTML ------------------------------------------------------------
  const cell = `style="text-align:start;padding:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:15px;line-height:1.5"`
  const heading = (text: string) =>
    `<tr><td ${cell}><h2 style="margin:16px 0 6px 0;font-size:17px;text-align:start">${escapeHtml(text)}</h2></td></tr>`
  const list = (items: string[]) =>
    `<tr><td ${cell}><ul style="margin:0;padding-inline-start:20px">${items.map((item) => `<li style="text-align:start">${item}</li>`).join("")}</ul></td></tr>`
  const rows: string[] = [
    `<tr><td ${cell}><h1 style="margin:0 0 4px 0;font-size:20px;text-align:start">${escapeHtml(subject)}</h1>` +
      (date ? `<div style="color:#6b7280;font-size:13px"><bdi dir="ltr">${escapeHtml(date)}</bdi></div>` : "") +
      `</td></tr>`,
  ]

  if (recap.overview) {
    rows.push(heading(strings.recapOverview))
    for (const paragraph of recap.overview.split(/\n{2,}|\r?\n/).filter((part) => part.trim())) {
      rows.push(`<tr><td ${cell}><p style="margin:0;text-align:start">${escapeHtml(paragraph)}</p></td></tr>`)
    }
  }
  if (recap.actionItems.length) {
    rows.push(heading(strings.recapActionItems))
    rows.push(
      list(
        recap.actionItems.map((item) => {
          const parts = [escapeHtml(item.title)]

          if (item.owner) parts.push(`${escapeHtml(strings.recapOwner)}: <bdi>${escapeHtml(item.owner)}</bdi>`)
          if (item.dueDate) parts.push(`${escapeHtml(strings.recapDue)}: <bdi dir="ltr">${escapeHtml(formatRecapDueDate(item.dueDate, locale))}</bdi>`)
          return parts.join(" · ")
        })
      )
    )
  }
  if (recap.decisions.length) {
    rows.push(heading(strings.recapDecisions))
    rows.push(list(recap.decisions.map(escapeHtml)))
  }
  if (recap.openQuestions.length) {
    rows.push(heading(strings.recapOpenQuestions))
    rows.push(list(recap.openQuestions.map(escapeHtml)))
  }

  const button = (href: string, label: string) =>
    `<tr><td ${cell}><a href="${href}" style="display:inline-block;padding:10px 18px;background:#111827;color:#ffffff;border-radius:6px;text-decoration:none">${escapeHtml(label)}</a></td></tr>`

  if (appHref) rows.push(button(appHref, strings.recapOpenInMeetSum))
  else if (shareHref) rows.push(button(shareHref, strings.recapOpenShare))

  const why = fill(escapeHtml(strings.recapWhyReceived), {
    title: `<bdi>${escapeHtml(title)}</bdi>`,
    workspace: `<bdi>${escapeHtml(input.workspaceName)}</bdi>`,
  })

  rows.push(
    `<tr><td style="text-align:start;padding:16px 0 0 0;border-top:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:12px;line-height:1.5">` +
      `<p style="margin:0 0 6px 0;text-align:start">${why}</p>` +
      (unsubscribeHref ? `<p style="margin:0;text-align:start"><a href="${unsubscribeHref}" style="color:#6b7280">${escapeHtml(strings.recapUnsubscribe)}</a></p>` : "") +
      `</td></tr>`
  )

  const html = `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body dir="${dir}" style="margin:0;padding:0;background:#f9fafb">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="background:#f9fafb"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;padding:24px">
${rows.join("\n")}
</table>
</td></tr></table>
</body>
</html>`

  // ---- Plain text ------------------------------------------------------
  const lines: string[] = [subject, ...(date ? [date] : []), ""]

  if (recap.overview) lines.push(strings.recapOverview, ...recap.overview.split(/\r?\n/).filter((part) => part.trim()), "")
  if (recap.actionItems.length) {
    lines.push(strings.recapActionItems)
    for (const item of recap.actionItems) {
      lines.push(
        `• ${item.title}${item.owner ? ` — ${item.owner}` : ""}${item.dueDate ? ` · ${strings.recapDue} ${formatRecapDueDate(item.dueDate, locale)}` : ""}`
      )
    }
    lines.push("")
  }
  if (recap.decisions.length) lines.push(strings.recapDecisions, ...recap.decisions.map((decision) => `• ${decision}`), "")
  if (recap.openQuestions.length) lines.push(strings.recapOpenQuestions, ...recap.openQuestions.map((question) => `• ${question}`), "")

  const prefix = (line: string) => (rtl && line ? `${RLM}${line}` : line)
  const text = [
    ...lines.map(prefix),
    // URLs stay on their own line, never RLM-prefixed.
    ...(input.appUrl ? [prefix(strings.recapOpenInMeetSum), input.appUrl, ""] : input.shareUrl ? [prefix(strings.recapOpenShare), input.shareUrl, ""] : []),
    prefix("—"),
    prefix(fill(strings.recapWhyReceived, { title, workspace: input.workspaceName })),
    prefix(strings.recapUnsubscribe),
    input.unsubscribeUrl,
  ].join("\n")

  return {
    to: input.to,
    subject,
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "Auto-Submitted": "auto-generated",
      "X-MeetSum-Meeting": recap.meetingId,
    },
  }
}
