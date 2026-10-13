import { describe, expect, it } from "vitest"

import { allowedExtraHeaders, buildMimeMessage } from "@/lib/email/mime"
import { buildMeetingRecapEmail } from "@/lib/email/templates/meeting-recap"
import { RLM } from "@/lib/integrations/bidi"
import type { MeetingRecap } from "@/lib/integrations/recap"

/**
 * M8 A10 template: Hebrew subject RFC 2047 round trip, `dir="rtl"`,
 * escaping, RLM text part, headers present and sanitized, header injection
 * refused.
 */

const RECAP: MeetingRecap = {
  meetingId: "m_he",
  title: "פגישת <b>מכירות</b>",
  language: "he",
  dir: "rtl",
  startedAt: "2026-10-01T07:00:00.000Z",
  participants: [],
  overview: "סקרנו את הצנרת & החלטנו <script>alert(1)</script>",
  actionItems: [{ id: "a1", title: "לשלוח הצעה", owner: "דנה כהן", dueDate: "2026-10-05", status: "open" }],
  decisions: ["להשיק בנובמבר"],
  openQuestions: [],
  links: { meeting: "https://app.test/he?meeting=m_he" },
  visibility: "workspace",
}

const INPUT = {
  to: "dana@acme.test",
  locale: "he" as const,
  recap: RECAP,
  workspaceName: "אקמי",
  appUrl: "https://app.test/he?meeting=m_he",
  unsubscribeUrl: "https://app.test/api/email/unsubscribe?t=abc.def",
  timeZone: "Asia/Jerusalem",
}

function decodeSubject(raw: string): string {
  const header = raw.split("\r\n").reduce<string[]>((acc, line) => {
    if (line.startsWith(" ") && acc.length) acc[acc.length - 1] += line
    else acc.push(line)
    return acc
  }, []).find((line) => line.startsWith("Subject: ")) ?? ""

  return header
    .slice("Subject: ".length)
    .split(" ")
    .map((word) => Buffer.from(/^=\?UTF-8\?B\?(.+)\?=$/.exec(word)?.[1] ?? "", "base64").toString("utf8"))
    .join("")
}

describe("buildMeetingRecapEmail", () => {
  it("renders Hebrew RTL HTML with escaped content, bdi owners and logical alignment", () => {
    const email = buildMeetingRecapEmail(INPUT)

    expect(email.subject).toBe("סיכום פגישה: פגישת <b>מכירות</b>")
    expect(email.html).toContain('<html lang="he" dir="rtl">')
    expect(email.html).toContain('<body dir="rtl"')
    expect(email.html).not.toMatch(/text-align:(left|right)|margin-left|margin-right|padding-left|padding-right/)
    expect(email.html).toContain("text-align:start")
    expect(email.html).not.toContain("<script>")
    expect(email.html).not.toContain("<b>מכירות")
    expect(email.html).toContain("&lt;script&gt;")
    expect(email.html).toContain("<bdi>דנה כהן</bdi>")
    expect(email.html).toContain('<bdi dir="ltr">2026-10-05</bdi>')
    expect(email.html).toContain('href="https://app.test/he?meeting=m_he"')
    expect(email.html).toContain("api/email/unsubscribe")
    expect(email.html).toContain("<bdi>אקמי</bdi>")
  })

  it("RLM-prefixes every Hebrew text line but never a URL", () => {
    const { text } = buildMeetingRecapEmail(INPUT)

    for (const line of text.split("\n").filter(Boolean)) {
      if (/^https?:\/\//.test(line)) expect(line.startsWith(RLM)).toBe(false)
      else expect(line.startsWith(RLM), line).toBe(true)
    }
    expect(text).toContain(INPUT.unsubscribeUrl)
  })

  it("renders English LTR without RLM and uses the share link for non-members", () => {
    const email = buildMeetingRecapEmail({
      ...INPUT,
      locale: "en",
      recap: { ...RECAP, title: "Sales sync", dir: "ltr", language: "en" },
      appUrl: undefined,
      shareUrl: "https://app.test/share/tok",
    })

    expect(email.subject).toBe("Meeting recap: Sales sync")
    expect(email.html).toContain('<html lang="en" dir="ltr">')
    expect(email.text).not.toContain(RLM)
    expect(email.html).toContain("https://app.test/share/tok")
    expect(email.html).not.toContain("?meeting=m_he")
  })

  it("sets the unsubscribe and auto-submitted headers and passes them through MIME (RFC 2047 subject round trip)", () => {
    const email = buildMeetingRecapEmail(INPUT)

    expect(email.headers).toEqual({
      "List-Unsubscribe": "<https://app.test/api/email/unsubscribe?t=abc.def>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "Auto-Submitted": "auto-generated",
      "X-MeetSum-Meeting": "m_he",
    })

    const raw = buildMimeMessage({ from: "recap@acme.test", to: email.to, subject: email.subject, text: email.text, html: email.html, headers: email.headers })

    expect(raw).toContain("\r\nList-Unsubscribe: <https://app.test/api/email/unsubscribe?t=abc.def>\r\n")
    expect(raw).toContain("\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n")
    expect(raw).toContain("\r\nAuto-Submitted: auto-generated\r\n")
    expect(raw).toContain("\r\nX-MeetSum-Meeting: m_he\r\n")
    expect(decodeSubject(raw)).toBe(email.subject)
  })

  it("refuses header injection and non-allowlisted headers", () => {
    expect(
      allowedExtraHeaders({
        "List-Unsubscribe": "<https://a.test/u>\r\nBcc: victim@evil.test",
        Bcc: "victim@evil.test",
        "Reply-To": "x@evil.test",
        "X-MeetSum-Meeting": "m1",
        "x-meetsum-bad name": "1",
        "X-MeetSum-Unicode": "שלום",
        "Auto-Submitted": "",
      })
    ).toEqual({ "List-Unsubscribe": "<https://a.test/u> Bcc: victim@evil.test", "X-MeetSum-Meeting": "m1" })

    const raw = buildMimeMessage({
      from: "a@acme.test",
      to: "b@acme.test",
      subject: "s",
      text: "t",
      headers: { "List-Unsubscribe": "<x>\r\nBcc: victim@evil.test", Subject: "override" },
    })
    const headerBlock = raw.split("\r\n\r\n")[0]

    expect(headerBlock).not.toMatch(/^Bcc:/m)
    expect(headerBlock.match(/^Subject:/gm)).toHaveLength(1)
  })
})
