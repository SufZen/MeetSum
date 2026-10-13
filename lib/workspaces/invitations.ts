import { getEmailSender, type EmailSender } from "@/lib/email"
import { notifyInvited } from "@/lib/notifications/notify"
import {
  buildInvitationEmail,
  type InvitationEmailLocale,
} from "@/lib/email/templates/invitation"
import type { WorkspaceStore } from "@/lib/workspaces/store"
import type { Invitation, Workspace } from "@/lib/workspaces/types"

/** Public origin used in invitation links. */
export function resolveAppOrigin(
  request: Pick<Request, "url">,
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = env.NEXT_PUBLIC_APP_URL?.trim() || env.MEETINGS_APP_URL?.trim()

  try {
    return new URL(configured || request.url).origin
  } catch {
    return new URL(request.url).origin
  }
}

export function buildInviteUrl(
  origin: string,
  locale: InvitationEmailLocale,
  token: string
): string {
  return new URL(`/${locale}/invite/${encodeURIComponent(token)}`, origin).toString()
}

export function toInvitationLocale(value: unknown): InvitationEmailLocale | undefined {
  return value === "he" || value === "en" ? value : undefined
}

export type InvitationDelivery = {
  inviteUrl: string
  emailSent: boolean
  provider: EmailSender["provider"]
  error?: string
}

/**
 * Email an invitation. Never throws: a send failure is stored on the
 * invitation (`last_send_error`) and the caller still returns `inviteUrl` so
 * an admin can copy the link.
 */
export async function deliverInvitation(input: {
  store: WorkspaceStore
  invitation: Invitation
  token: string
  workspace: Workspace
  inviterName?: string
  locale: InvitationEmailLocale
  origin: string
  sender?: EmailSender
}): Promise<InvitationDelivery> {
  // M9: in-app `invited` notification for an existing user (dedupe inv:<id>).
  await notifyInvited({ invitationId: input.invitation.id }).catch(() => {})
  const inviteUrl = buildInviteUrl(input.origin, input.locale, input.token)
  const sender = input.sender ?? getEmailSender()

  // The log sender delivers nothing: keep the copy-the-link flow for it.
  if (!sender.isConfigured() || sender.provider === "log") {
    await input.store
      .recordInvitationSend(input.invitation.id, { error: "email_not_configured" })
      .catch(() => {})

    return { inviteUrl, emailSent: false, provider: sender.provider, error: "email_not_configured" }
  }

  try {
    await sender.send(
      buildInvitationEmail({
        to: input.invitation.email,
        locale: input.locale,
        workspaceName: input.workspace.name,
        inviterName: input.inviterName,
        role: input.invitation.role,
        inviteUrl,
        expiresAt: input.invitation.expiresAt,
      })
    )
    await input.store.recordInvitationSend(input.invitation.id, { error: null }).catch(() => {})

    return { inviteUrl, emailSent: true, provider: sender.provider }
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)

    console.error("[invitations] email delivery failed", {
      invitationId: input.invitation.id,
      provider: sender.provider,
      error: message,
    })
    await input.store
      .recordInvitationSend(input.invitation.id, { error: message })
      .catch(() => {})

    return { inviteUrl, emailSent: false, provider: sender.provider, error: message }
  }
}
