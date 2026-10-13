import { getEmailSender, type EmailSender } from "@/lib/email"
import { notifyInvited } from "@/lib/notifications/notify"
import {
  buildInvitationEmail,
  type InvitationEmailLocale,
} from "@/lib/email/templates/invitation"
import { WorkspaceStoreError, type WorkspaceStore } from "@/lib/workspaces/store"
import type { Invitation, Membership, Workspace, WorkspaceUser } from "@/lib/workspaces/types"

/**
 * M9 (Package C): accepts a pending invitation by id for the signed-in user,
 * from the bell or `POST /api/me/invitations/[id]/accept`. The session email
 * must equal the invitation email (checked before anything changes); the
 * store then accepts by id in one transaction that locks the row and
 * re-checks pending, so the invitation is single-use. The emailed token is
 * never rotated: if the accept fails, the link in the email still works.
 * Accepted, revoked and expired invitations throw.
 */
export async function acceptInvitationById(
  store: WorkspaceStore,
  input: { workspaceId: string; invitationId: string; user: Pick<WorkspaceUser, "id" | "email"> },
  now: number = Date.now()
): Promise<{ membership: Membership; workspace: Workspace; invitation: Invitation }> {
  const invitation = await store.getInvitation(input.workspaceId, input.invitationId)
  const workspace = invitation ? await store.getWorkspace(invitation.workspaceId) : undefined

  if (!invitation || !workspace) throw new WorkspaceStoreError("not_found", "Invitation not found")

  if (invitation.status !== "pending" || Date.parse(invitation.expiresAt) <= now) {
    throw new WorkspaceStoreError("invitation_invalid", "Invitation is no longer valid")
  }
  if (input.user.email.trim().toLowerCase() !== invitation.email.trim().toLowerCase()) {
    throw new WorkspaceStoreError("email_mismatch", "Invitation is for a different email")
  }

  return store.acceptInvitationById({
    workspaceId: invitation.workspaceId,
    invitationId: invitation.id,
    user: input.user,
  })
}

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
