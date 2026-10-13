import { afterEach, describe, expect, it, vi } from "vitest"

import { getEmailSender, resolveEmailProvider } from "@/lib/email"
import {
  buildMimeMessage,
  encodeHeaderWord,
  formatAddress,
  sanitizeHeaderValue,
  toBase64Url,
} from "@/lib/email/mime"
import { buildInvitationEmail } from "@/lib/email/templates/invitation"
import type { EmailSender } from "@/lib/email/types"
import { deliverInvitation } from "@/lib/workspaces/invitations"
import { createInMemoryWorkspaceStore } from "@/lib/workspaces/store"

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv

function decodeWords(header: string): string {
  return header
    .split(/\r\n /)
    .map((word) => {
      const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(word)

      expect(match, word).not.toBeNull()
      return Buffer.from(match![1], "base64").toString("utf8")
    })
    .join("")
}

describe("RFC 2047 headers", () => {
  it("keeps ASCII subjects as-is", () => {
    expect(encodeHeaderWord("Hello MeetSum")).toBe("Hello MeetSum")
  })

  it("encodes Hebrew subjects as UTF-8 B-words of at most 75 chars that round-trip", () => {
    const subject = "הוזמנת להצטרף לסביבת העבודה של צוות המכירות ב-MeetSum — ברוכים הבאים!"
    const encoded = encodeHeaderWord(subject)

    for (const word of encoded.split("\r\n ")) {
      expect(word.length).toBeLessThanOrEqual(75)
      expect(word).toMatch(/^=\?UTF-8\?B\?.+\?=$/)
    }
    expect(encoded.split("\r\n ").length).toBeGreaterThan(1)
    expect(decodeWords(encoded)).toBe(subject)
  })

  it("strips CR/LF to block header injection", () => {
    expect(sanitizeHeaderValue("Hi\r\nBcc: victim@example.com")).toBe("Hi Bcc: victim@example.com")
    expect(encodeHeaderWord("a\nb")).toBe("a b")
  })

  it("formats display names (quoted ASCII, encoded Unicode)", () => {
    expect(formatAddress("noreply@example.com", 'Meet "Sum"')).toBe(
      '"Meet \\"Sum\\"" <noreply@example.com>'
    )
    expect(formatAddress("noreply@example.com", "מיטסאם")).toMatch(
      /^=\?UTF-8\?B\?.+\?= <noreply@example.com>$/
    )
  })
})

describe("MIME message", () => {
  it("builds multipart/alternative with base64 UTF-8 parts and CRLF endings", () => {
    const raw = buildMimeMessage({
      from: "noreply@example.com",
      fromName: "MeetSum",
      to: "dana@example.com",
      subject: "שלום",
      text: "טקסט",
      html: '<p dir="rtl">טקסט</p>',
      boundary: "b1",
    })

    expect(raw).toContain("Content-Type: multipart/alternative; boundary=\"b1\"")
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("שלום").toString("base64")}?=`)
    expect(raw).toContain(Buffer.from("טקסט").toString("base64"))
    expect(raw).toContain("--b1--")
    expect(raw.split("\n").every((line, index, lines) => index === lines.length - 1 || line.endsWith("\r"))).toBe(true)
    expect(toBase64Url(raw)).not.toMatch(/[+/=]/)
  })

  it("builds a single text part without html", () => {
    const raw = buildMimeMessage({
      from: "a@example.com",
      to: "b@example.com",
      subject: "Hi",
      text: "Body",
    })

    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8")
    expect(raw).not.toContain("multipart")
  })
})

describe("invitation template", () => {
  const base = {
    to: "dana@example.com",
    workspaceName: "צוות <מכירות>",
    inviterName: "Avi",
    role: "member" as const,
    inviteUrl: "https://meetsum.example.com/he/invite/inv_x",
    expiresAt: "2026-10-19T00:00:00.000Z",
  }

  it("renders Hebrew with an RTL HTML body and escaped values", () => {
    const message = buildInvitationEmail({ ...base, locale: "he" })

    expect(message.subject).toContain("הוזמנת")
    expect(message.html).toContain('dir="rtl"')
    expect(message.html).toContain('lang="he"')
    expect(message.html).toContain("&lt;מכירות&gt;")
    expect(message.html).not.toContain("<מכירות>")
    expect(message.text).toContain(base.inviteUrl)
  })

  it("renders English", () => {
    const message = buildInvitationEmail({ ...base, workspaceName: "Sales", locale: "en" })

    expect(message.subject).toBe("You're invited to join Sales on MeetSum")
    expect(message.html).not.toContain('dir="rtl"')
    expect(message.text).toContain("Accept the invitation")
  })
})

describe("provider selection", () => {
  it("auto picks smtp, then gmail (DWD + from), then log", () => {
    expect(resolveEmailProvider(env({ SMTP_HOST: "smtp.example.com" }))).toBe("smtp")
    expect(
      resolveEmailProvider(
        env({ GOOGLE_SERVICE_ACCOUNT_EMAIL: "sa@x.iam", MEETSUM_EMAIL_FROM: "noreply@example.com" })
      )
    ).toBe("gmail")
    expect(resolveEmailProvider(env({ GOOGLE_SERVICE_ACCOUNT_EMAIL: "sa@x.iam" }))).toBe("log")
    expect(resolveEmailProvider(env({}))).toBe("log")
    expect(resolveEmailProvider(env({ MEETSUM_EMAIL_PROVIDER: "log", SMTP_HOST: "h" }))).toBe("log")
  })

  it("the log sender counts as configured outside production and never logs the body, address or subject", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const sender = getEmailSender(env({}))

    expect(sender.provider).toBe("log")
    expect(sender.isConfigured()).toBe(true)
    await sender.send({ to: "a@example.com", subject: "subject-line", text: "secret-token-body" })

    const logged = JSON.stringify(info.mock.calls)

    expect(logged).not.toContain("secret-token-body")
    expect(logged).not.toContain("a@example.com")
    expect(logged).not.toContain("subject-line")
    expect(logged).toMatch(/recipients.*1/)
    info.mockRestore()
  })

  it("the log sender is not configured in production, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const sender = getEmailSender(env({ NODE_ENV: "production", MEETSUM_EMAIL_PROVIDER: "log" }))

    expect(sender.isConfigured()).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("deliverInvitation", () => {
  afterEach(() => vi.restoreAllMocks())

  async function setup() {
    const store = createInMemoryWorkspaceStore()
    const owner = await store.upsertUser({ email: "owner@example.com" })
    const workspace = await store.createWorkspace({ name: "Acme", createdByUserId: owner.id })
    const { invitation, token } = await store.createInvitation({
      workspaceId: workspace.id,
      email: "dana@example.com",
      role: "member",
    })

    return { store, workspace, invitation, token }
  }

  it("never throws on send failure, stores last_send_error and returns the invite URL", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { store, workspace, invitation, token } = await setup()
    const sender: EmailSender = {
      provider: "smtp",
      isConfigured: () => true,
      send: async () => {
        throw new Error("connection refused")
      },
    }
    const result = await deliverInvitation({
      store,
      invitation,
      token,
      workspace,
      locale: "he",
      origin: "https://meetsum.example.com",
      sender,
    })

    expect(result).toMatchObject({
      emailSent: false,
      error: "connection refused",
      inviteUrl: `https://meetsum.example.com/he/invite/${token}`,
    })
    expect((await store.getInvitation(workspace.id, invitation.id))?.lastSendError).toBe(
      "connection refused"
    )
  })

  it("sends the localized message and records success", async () => {
    const { store, workspace, invitation, token } = await setup()
    const send = vi.fn(async () => ({ provider: "gmail" as const, messageId: "m1" }))
    const result = await deliverInvitation({
      store,
      invitation,
      token,
      workspace,
      locale: "en",
      origin: "https://meetsum.example.com",
      sender: { provider: "gmail", isConfigured: () => true, send },
    })

    expect(result.emailSent).toBe(true)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "dana@example.com", text: expect.stringContaining(token) })
    )
    expect((await store.getInvitation(workspace.id, invitation.id))?.sendCount).toBe(1)
  })
})
