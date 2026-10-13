import { buildMimeMessage, toBase64Url } from "@/lib/email/mime"
import type {
  EmailMessage,
  EmailProvider,
  EmailSendResult,
  EmailSender,
} from "@/lib/email/types"

export type { EmailMessage, EmailProvider, EmailSendResult, EmailSender }

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()

  return trimmed ? trimmed : undefined
}

function fromName(env: NodeJS.ProcessEnv): string {
  return clean(env.MEETSUM_EMAIL_FROM_NAME) ?? "MeetSum"
}

/** Domain-wide delegation (or first-admin OAuth) is configured for Google APIs. */
function hasGoogleDelegation(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.GOOGLE_WORKSPACE_AUTH_STRATEGY === "user-oauth" ||
      clean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL) ||
      clean(env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT) ||
      clean(env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE)
  )
}

/**
 * Provider chosen by `MEETSUM_EMAIL_PROVIDER` (`auto` default): SMTP when
 * `SMTP_HOST` is set, else Gmail when Google delegation and
 * `MEETSUM_EMAIL_FROM` are configured, else the log fallback.
 */
export function resolveEmailProvider(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  const requested = clean(env.MEETSUM_EMAIL_PROVIDER)?.toLowerCase() ?? "auto"

  if (requested === "gmail" || requested === "smtp" || requested === "log") {
    return requested
  }

  if (clean(env.SMTP_HOST)) return "smtp"
  if (hasGoogleDelegation(env) && clean(env.MEETSUM_EMAIL_FROM)) return "gmail"

  return "log"
}

export function createLogEmailSender(): EmailSender {
  return {
    provider: "log",
    isConfigured: () => false,
    async send(message) {
      // Never log the body: invitation emails carry a one-time token.
      console.info("[email] no provider configured; not sent", {
        to: message.to,
        subject: message.subject,
      })

      return { provider: "log" }
    },
  }
}

export function createGmailEmailSender(env: NodeJS.ProcessEnv = process.env): EmailSender {
  const from = clean(env.MEETSUM_EMAIL_FROM)

  return {
    provider: "gmail",
    isConfigured: () => Boolean(from && hasGoogleDelegation(env)),
    async send(message) {
      if (!from) throw new Error("MEETSUM_EMAIL_FROM is required for Gmail delivery")

      const [{ google }, { createDelegatedGoogleClient }] = await Promise.all([
        import("googleapis"),
        import("@/lib/google/auth"),
      ])
      const auth = await createDelegatedGoogleClient(from, [GMAIL_SEND_SCOPE])
      const gmail = google.gmail({ version: "v1", auth })
      const raw = toBase64Url(
        buildMimeMessage({
          from,
          fromName: fromName(env),
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          replyTo: message.replyTo,
        })
      )
      const response = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      })

      return { provider: "gmail", messageId: response.data.id ?? undefined }
    },
  }
}

export function createSmtpEmailSender(env: NodeJS.ProcessEnv = process.env): EmailSender {
  const host = clean(env.SMTP_HOST)
  const from = clean(env.MEETSUM_EMAIL_FROM) ?? clean(env.SMTP_USER)

  return {
    provider: "smtp",
    isConfigured: () => Boolean(host && from),
    async send(message) {
      if (!host) throw new Error("SMTP_HOST is required for SMTP delivery")
      if (!from) throw new Error("MEETSUM_EMAIL_FROM (or SMTP_USER) is required")

      const nodemailer = await import("nodemailer")
      const port = Number(env.SMTP_PORT) || 587
      const user = clean(env.SMTP_USER)
      const transport = nodemailer.createTransport({
        host,
        port,
        secure: env.SMTP_SECURE === "true",
        ...(user ? { auth: { user, pass: env.SMTP_PASSWORD ?? "" } } : {}),
      })
      const info = await transport.sendMail({
        from: { name: fromName(env), address: from },
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      })

      return { provider: "smtp", messageId: info.messageId }
    },
  }
}

export function getEmailSender(env: NodeJS.ProcessEnv = process.env): EmailSender {
  const provider = resolveEmailProvider(env)

  if (provider === "smtp") return createSmtpEmailSender(env)
  if (provider === "gmail") return createGmailEmailSender(env)

  return createLogEmailSender()
}
