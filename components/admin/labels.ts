import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { MeetingVisibility } from "@/lib/meetings/repository"
import type { InvitationStatus, WorkspaceRole } from "@/lib/workspaces/types"

import type { ApiKeyScopeName } from "@/components/admin/api"

export function roleLabel(t: Dictionary, role: WorkspaceRole): string {
  const labels: Record<WorkspaceRole, string> = {
    owner: t.roleOwner,
    admin: t.roleAdmin,
    member: t.roleMember,
    viewer: t.roleViewer,
  }

  return labels[role]
}

export function invitationStatusLabel(
  t: Dictionary,
  status: InvitationStatus
): string {
  const labels: Record<InvitationStatus, string> = {
    pending: t.invitationStatusPending,
    accepted: t.invitationStatusAccepted,
    revoked: t.invitationStatusRevoked,
    expired: t.invitationStatusExpired,
  }

  return labels[status] ?? status
}

export function scopeLabel(t: Dictionary, scope: ApiKeyScopeName): string {
  const labels: Record<ApiKeyScopeName, string> = {
    read: t.apiKeyScopeRead,
    write: t.apiKeyScopeWrite,
    admin: t.apiKeyScopeAdmin,
  }

  return labels[scope]
}

export function visibilityLabel(
  t: Dictionary,
  visibility: MeetingVisibility
): { label: string; hint: string } {
  if (visibility === "private") {
    return { label: t.visibilityPrivate, hint: t.visibilityPrivateHint }
  }

  if (visibility === "link") {
    return { label: t.visibilityLink, hint: t.visibilityLinkHint }
  }

  return { label: t.visibilityWorkspace, hint: t.visibilityWorkspaceHint }
}

/** Locale-aware date/time (Hebrew uses he-IL formatting). */
export function formatDateTime(
  locale: string,
  value?: string | null,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  }
): string {
  if (!value) return "—"

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return "—"

  return new Intl.DateTimeFormat(
    locale === "he" ? "he-IL" : locale,
    options
  ).format(date)
}
