export type EmailProvider = "gmail" | "smtp" | "log"

export type EmailMessage = {
  to: string
  subject: string
  text: string
  html?: string
  replyTo?: string
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
