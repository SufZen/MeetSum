import { ApiError, type ApiKeyScopeName } from "@/components/admin/api"
import { apiErrorMessage } from "@/lib/i18n/api-errors"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { formatDate, type DateStyle, type Fmt } from "@/lib/i18n/format"
import type { MeetingVisibility } from "@/lib/meetings/repository"
import type { InvitationStatus, WorkspaceRole } from "@/lib/workspaces/types"

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

/** Locale- and time-zone-aware date/time via `lib/i18n/format` ("—" when missing). */
export function formatDateTime(
  fmt: Fmt,
  value?: string | null,
  style: DateStyle = "dateTime"
): string {
  if (!value) return "—"

  return formatDate(value, fmt, style) || "—"
}

/**
 * Localized text for a failed admin API call: a known `ApiError` code maps
 * to its `apiErr*` message; anything else (network errors, unknown shapes)
 * becomes `fallback`, so server English never reaches a Hebrew UI.
 */
export function adminErrorMessage(
  error: unknown,
  t: Dictionary,
  fallback: string
): string {
  if (error instanceof ApiError) {
    return apiErrorMessage({ error: error.code, message: error.message }, t, fallback)
  }

  return fallback
}
