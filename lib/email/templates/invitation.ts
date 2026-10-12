import type { EmailMessage } from "@/lib/email/types"

export type InvitationEmailLocale = "he" | "en"

export type InvitationEmailInput = {
  to: string
  locale: InvitationEmailLocale
  workspaceName: string
  inviterName?: string
  role: "admin" | "member" | "viewer"
  inviteUrl: string
  expiresAt: string
  replyTo?: string
}

const ROLE_LABELS: Record<InvitationEmailLocale, Record<InvitationEmailInput["role"], string>> = {
  he: { admin: "מנהל/ת", member: "חבר/ת צוות", viewer: "צופה" },
  en: { admin: "Admin", member: "Member", viewer: "Viewer" },
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function formatDate(value: string, locale: InvitationEmailLocale): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(date)
}

/** Invitation email in Hebrew (RTL HTML) or English. */
export function buildInvitationEmail(input: InvitationEmailInput): EmailMessage {
  const role = ROLE_LABELS[input.locale][input.role]
  const expires = formatDate(input.expiresAt, input.locale)
  const inviter = input.inviterName?.trim()

  if (input.locale === "he") {
    const subject = `הוזמנת להצטרף ל-${input.workspaceName} ב-MeetSum`
    const lead = inviter
      ? `${inviter} הזמין/ה אותך להצטרף לסביבת העבודה "${input.workspaceName}" ב-MeetSum בתפקיד ${role}.`
      : `הוזמנת להצטרף לסביבת העבודה "${input.workspaceName}" ב-MeetSum בתפקיד ${role}.`
    const text = [
      "שלום,",
      "",
      lead,
      "",
      `לקבלת ההזמנה: ${input.inviteUrl}`,
      "",
      `ההזמנה בתוקף עד ${expires}. יש להתחבר עם חשבון Google של ${input.to}.`,
    ].join("\n")
    const html = `<!doctype html>
<html lang="he" dir="rtl">
<body dir="rtl" style="font-family:Arial,Helvetica,sans-serif;text-align:right;direction:rtl;color:#1f2937">
<p>שלום,</p>
<p>${escapeHtml(lead)}</p>
<p><a href="${escapeHtml(input.inviteUrl)}" style="display:inline-block;padding:10px 18px;background:#111827;color:#ffffff;border-radius:6px;text-decoration:none">קבלת ההזמנה</a></p>
<p style="color:#6b7280;font-size:13px">ההזמנה בתוקף עד ${escapeHtml(expires)}. יש להתחבר עם חשבון Google של <span dir="ltr">${escapeHtml(input.to)}</span>.</p>
</body>
</html>`

    return { to: input.to, subject, text, html, replyTo: input.replyTo }
  }

  const subject = `You're invited to join ${input.workspaceName} on MeetSum`
  const lead = inviter
    ? `${inviter} invited you to join the "${input.workspaceName}" workspace on MeetSum as ${role}.`
    : `You've been invited to join the "${input.workspaceName}" workspace on MeetSum as ${role}.`
  const text = [
    "Hi,",
    "",
    lead,
    "",
    `Accept the invitation: ${input.inviteUrl}`,
    "",
    `This invitation expires on ${expires}. Sign in with the Google account for ${input.to}.`,
  ].join("\n")
  const html = `<!doctype html>
<html lang="en" dir="ltr">
<body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<p>Hi,</p>
<p>${escapeHtml(lead)}</p>
<p><a href="${escapeHtml(input.inviteUrl)}" style="display:inline-block;padding:10px 18px;background:#111827;color:#ffffff;border-radius:6px;text-decoration:none">Accept invitation</a></p>
<p style="color:#6b7280;font-size:13px">This invitation expires on ${escapeHtml(expires)}. Sign in with the Google account for ${escapeHtml(input.to)}.</p>
</body>
</html>`

  return { to: input.to, subject, text, html, replyTo: input.replyTo }
}
