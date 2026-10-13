export type EmailProvider = "gmail" | "smtp" | "log"

export type EmailMessage = {
  to: string
  subject: string
  text: string
  html?: string
  replyTo?: string
  /**
   * M8: extra headers (List-Unsubscribe, List-Unsubscribe-Post,
   * Auto-Submitted, X-MeetSum-*). Type only in Step 0; the MIME builder
   * passes through an allowlist with sanitized values (Package A).
   */
  headers?: Record<string, string>
}

export type EmailSendResult = {
  provider: EmailProvider
  messageId?: string
}

export type EmailSender = {
  provider: EmailProvider
  /** False for the `log` fallback: nothing is actually delivered. */
  isConfigured(): boolean
  send(message: EmailMessage): Promise<EmailSendResult>
}
