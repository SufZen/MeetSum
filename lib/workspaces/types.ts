export type WorkspaceRole = "owner" | "admin" | "member" | "viewer"

export type Workspace = {
  id: string
  name: string
  slug: string
  /** Domain-wide-delegation identity used for Google APIs. */
  googleSubject?: string
}

export type WorkspaceUser = {
  id: string
  email: string
  name?: string
  picture?: string
}

export type Membership = {
  workspaceId: string
  userId: string
  role: WorkspaceRole
  invitedByUserId?: string
  createdAt?: string
  updatedAt?: string
}

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired"

export type Invitation = {
  id: string
  workspaceId: string
  email: string
  role: Exclude<WorkspaceRole, "owner">
  status: InvitationStatus
  invitedByUserId?: string
  acceptedByUserId?: string
  expiresAt: string
  acceptedAt?: string
  lastSentAt?: string
  sendCount: number
  lastSendError?: string
  createdAt: string
  updatedAt: string
}
