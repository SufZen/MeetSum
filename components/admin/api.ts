/**
 * Typed browser client for the M2 workspace / admin APIs (Package A routes).
 *
 * All request and response shapes used by the UI live here so the
 * contract with the server is centralized (docs/parity/m2.md, A5).
 * Responses are normalized defensively: missing optional fields never
 * crash the UI.
 */

import type { Permission } from "@/lib/auth/authz"
import type { MeetingVisibility } from "@/lib/meetings/repository"
import type { InvitationStatus, WorkspaceRole } from "@/lib/workspaces/types"

export type InvitableRole = Exclude<WorkspaceRole, "owner">
export type ApiKeyScopeName = "read" | "write" | "admin"

export type MeUser = {
  id: string
  email: string
  name?: string
  picture?: string
}

export type MeWorkspace = {
  id: string
  name: string
  role: WorkspaceRole
}

export type Me = {
  user: MeUser
  workspaces: MeWorkspace[]
  activeWorkspaceId: string | null
  permissions: Permission[]
}

export type WorkspaceMember = {
  userId: string
  email: string
  name?: string
  picture?: string
  role: WorkspaceRole
  createdAt?: string
}

export type WorkspaceInvitation = {
  id: string
  email: string
  role: InvitableRole
  status: InvitationStatus
  expiresAt?: string
  createdAt?: string
  lastSentAt?: string
  sendCount: number
  lastSendError?: string
}

export type CreatedInvitation = {
  invitation: WorkspaceInvitation
  inviteUrl: string
  /** True when the invitation email was handed to a mail provider. */
  emailSent: boolean
  sendError?: string
}

export type ApiKeyView = {
  id: string
  label: string
  keyPrefix: string
  scopes: ApiKeyScopeName[]
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
}

export type AuditLogView = {
  id: string
  action: string
  actor?: string
  targetType?: string
  targetId?: string
  metadata: Record<string, unknown>
  createdAt: string
}

export type AuditLogFilters = {
  action?: string
  actor?: string
  targetType?: string
  targetId?: string
}

export type AuditLogPage = {
  logs: AuditLogView[]
  nextCursor: string | null
}

export type PublicInvitation = {
  workspaceName: string
  email: string
  role: InvitableRole
  status: InvitationStatus
  expiresAt?: string
  invitedBy?: string
}

/** Error carrying the HTTP status and server error code/message. */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

type Json = Record<string, unknown>

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

const ROLES: readonly WorkspaceRole[] = ["owner", "admin", "member", "viewer"]

function asRole(
  value: unknown,
  fallback: WorkspaceRole = "viewer"
): WorkspaceRole {
  return ROLES.includes(value as WorkspaceRole)
    ? (value as WorkspaceRole)
    : fallback
}

async function request<T = Json>(
  url: string,
  init?: RequestInit & { json?: unknown }
): Promise<T> {
  const { json, ...rest } = init ?? {}
  const response = await fetch(url, {
    ...rest,
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...rest.headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: "same-origin",
  })
  const body = (await response.json().catch(() => ({}))) as Json

  if (!response.ok) {
    const code =
      asString(body.code) ?? asString(body.reason) ?? asString(body.error)

    throw new ApiError(
      asString(body.message) ?? asString(body.error) ?? response.statusText,
      response.status,
      code
    )
  }

  return body as T
}

// --- Session / workspaces -------------------------------------------------

export function normalizeMe(body: Json): Me {
  const user = asRecord(body.user)

  return {
    user: {
      id: asString(user.id) ?? asString(user.email) ?? "",
      email: asString(user.email) ?? "",
      name: asString(user.name),
      picture: asString(user.picture) ?? asString(user.pictureUrl),
    },
    workspaces: asArray(body.workspaces).map((item) => {
      const workspace = asRecord(item)

      return {
        id: asString(workspace.id) ?? "",
        name: asString(workspace.name) ?? asString(workspace.id) ?? "",
        role: asRole(workspace.role),
      }
    }),
    activeWorkspaceId: asString(body.activeWorkspaceId) ?? null,
    permissions: asArray(body.permissions).filter(
      (permission): permission is Permission => typeof permission === "string"
    ),
  }
}

export async function fetchMe(): Promise<Me> {
  return normalizeMe(await request("/api/me"))
}

export async function createWorkspace(name: string) {
  const body = await request("/api/workspaces", {
    method: "POST",
    json: { name },
  })
  const workspace = asRecord(body.workspace)

  return {
    id: asString(workspace.id) ?? asString(body.id) ?? "",
    name: asString(workspace.name) ?? name,
  }
}

export async function switchWorkspace(workspaceId: string) {
  await request("/api/workspaces/switch", {
    method: "POST",
    json: { workspaceId },
  })
}

// --- Members ---------------------------------------------------------------

function normalizeMember(item: unknown): WorkspaceMember {
  const member = asRecord(item)
  const user = asRecord(member.user)

  return {
    userId:
      asString(member.userId) ?? asString(user.id) ?? asString(member.id) ?? "",
    email: asString(member.email) ?? asString(user.email) ?? "",
    name: asString(member.name) ?? asString(user.name),
    picture:
      asString(member.picture) ??
      asString(user.picture) ??
      asString(member.pictureUrl),
    role: asRole(member.role),
    createdAt: asString(member.createdAt),
  }
}

export async function listMembers(): Promise<WorkspaceMember[]> {
  const body = await request("/api/workspaces/current/members")

  return asArray(body.members).map(normalizeMember)
}

export async function updateMemberRole(userId: string, role: WorkspaceRole) {
  await request(
    `/api/workspaces/current/members/${encodeURIComponent(userId)}`,
    { method: "PATCH", json: { role } }
  )
}

export async function removeMember(userId: string) {
  await request(
    `/api/workspaces/current/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" }
  )
}

// --- Invitations -----------------------------------------------------------

function normalizeInvitation(item: unknown): WorkspaceInvitation {
  const invitation = asRecord(item)
  const role = asRole(invitation.role, "member")

  return {
    id: asString(invitation.id) ?? "",
    email: asString(invitation.email) ?? "",
    role: role === "owner" ? "admin" : role,
    status: (asString(invitation.status) ?? "pending") as InvitationStatus,
    expiresAt: asString(invitation.expiresAt),
    createdAt: asString(invitation.createdAt),
    lastSentAt: asString(invitation.lastSentAt),
    sendCount:
      typeof invitation.sendCount === "number" ? invitation.sendCount : 0,
    lastSendError: asString(invitation.lastSendError),
  }
}

function normalizeCreatedInvitation(body: Json): CreatedInvitation {
  const invitation = normalizeInvitation(body.invitation)
  const sendError =
    asString(body.sendError) ??
    asString(body.emailError) ??
    invitation.lastSendError

  return {
    invitation,
    inviteUrl: asString(body.inviteUrl) ?? "",
    emailSent:
      typeof body.emailSent === "boolean" ? body.emailSent : !sendError,
    sendError,
  }
}

export async function listInvitations(): Promise<WorkspaceInvitation[]> {
  const body = await request("/api/workspaces/current/invitations")

  return asArray(body.invitations).map(normalizeInvitation)
}

export async function createInvitation(input: {
  email: string
  role: InvitableRole
}): Promise<CreatedInvitation> {
  return normalizeCreatedInvitation(
    await request("/api/workspaces/current/invitations", {
      method: "POST",
      json: input,
    })
  )
}

export async function resendInvitation(id: string): Promise<CreatedInvitation> {
  return normalizeCreatedInvitation(
    await request(
      `/api/workspaces/current/invitations/${encodeURIComponent(id)}/resend`,
      { method: "POST" }
    )
  )
}

export async function revokeInvitation(id: string) {
  await request(
    `/api/workspaces/current/invitations/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  )
}

export function normalizePublicInvitation(body: Json): PublicInvitation {
  const invitation = asRecord(body.invitation ?? body)
  const workspace = asRecord(invitation.workspace ?? body.workspace)
  const role = asRole(invitation.role, "member")

  return {
    workspaceName:
      asString(invitation.workspaceName) ?? asString(workspace.name) ?? "",
    email: asString(invitation.email) ?? "",
    role: role === "owner" ? "admin" : role,
    status: (asString(invitation.status) ?? "pending") as InvitationStatus,
    expiresAt: asString(invitation.expiresAt),
    invitedBy:
      asString(invitation.invitedByName) ?? asString(invitation.invitedBy),
  }
}

export async function getPublicInvitation(
  token: string
): Promise<PublicInvitation> {
  return normalizePublicInvitation(
    await request(`/api/invitations/${encodeURIComponent(token)}`)
  )
}

export async function acceptInvitation(token: string) {
  const body = await request(
    `/api/invitations/${encodeURIComponent(token)}/accept`,
    { method: "POST" }
  )

  return { workspaceId: asString(body.workspaceId) ?? null }
}

// --- API keys --------------------------------------------------------------

function normalizeApiKey(item: unknown): ApiKeyView {
  const key = asRecord(item)

  return {
    id: asString(key.id) ?? "",
    label: asString(key.label) ?? "",
    keyPrefix: asString(key.keyPrefix) ?? "",
    scopes: asArray(key.scopes).filter(
      (scope): scope is ApiKeyScopeName =>
        scope === "read" || scope === "write" || scope === "admin"
    ),
    createdAt: asString(key.createdAt) ?? "",
    expiresAt: asString(key.expiresAt) ?? null,
    revokedAt: asString(key.revokedAt) ?? null,
    lastUsedAt: asString(key.lastUsedAt) ?? null,
  }
}

export async function listApiKeys(): Promise<ApiKeyView[]> {
  const body = await request("/api/admin/api-keys")

  return asArray(body.keys).map(normalizeApiKey)
}

/** Scope hierarchy: admin ⊃ write ⊃ read. */
export function scopesFor(level: ApiKeyScopeName): ApiKeyScopeName[] {
  if (level === "admin") return ["read", "write", "admin"]
  if (level === "write") return ["read", "write"]
  return ["read"]
}

export function scopeLevel(
  scopes: readonly ApiKeyScopeName[]
): ApiKeyScopeName {
  if (scopes.includes("admin")) return "admin"
  if (scopes.includes("write")) return "write"
  return "read"
}

export async function createApiKey(input: {
  label: string
  scope: ApiKeyScopeName
  expiresAt?: string | null
}): Promise<{ rawKey: string; record: ApiKeyView }> {
  const body = await request("/api/admin/api-keys", {
    method: "POST",
    json: {
      label: input.label,
      scopes: scopesFor(input.scope),
      expiresAt: input.expiresAt ?? null,
    },
  })

  return {
    rawKey: asString(body.key) ?? asString(body.rawKey) ?? "",
    record: normalizeApiKey(body.record),
  }
}

export async function revokeApiKey(id: string) {
  await request(`/api/admin/api-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
}

// --- Audit log -------------------------------------------------------------

export async function listAuditLogs(
  filters: AuditLogFilters,
  cursor?: string | null,
  limit = 50
): Promise<AuditLogPage> {
  const params = new URLSearchParams({ limit: String(limit) })

  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value.trim()) params.set(key, value.trim())
  }

  if (cursor) params.set("cursor", cursor)

  const body = await request(`/api/admin/audit-logs?${params}`)

  return {
    logs: asArray(body.logs).map((item) => {
      const log = asRecord(item)

      return {
        id: asString(log.id) ?? "",
        action: asString(log.action) ?? "",
        actor: asString(log.actor),
        targetType: asString(log.targetType),
        targetId: asString(log.targetId),
        metadata: asRecord(log.metadata),
        createdAt: asString(log.createdAt) ?? "",
      }
    }),
    nextCursor: asString(body.nextCursor) ?? null,
  }
}

// --- Meetings --------------------------------------------------------------

export async function updateMeetingVisibility(
  meetingId: string,
  visibility: MeetingVisibility
) {
  const body = await request(
    `/api/meetings/${encodeURIComponent(meetingId)}/visibility`,
    { method: "PATCH", json: { visibility } }
  )
  const meeting = asRecord(body.meeting)

  return {
    visibility: (asString(meeting.visibility) ??
      visibility) as MeetingVisibility,
  }
}
