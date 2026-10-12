import type { Queryable } from "@/lib/db/client"
import {
  ensureBootstrapWorkspace,
  resolveBootstrapIdentities,
} from "@/lib/workspaces/bootstrap"
import { DEFAULT_WORKSPACE_ID, roleRank } from "@/lib/workspaces/constants"
import {
  createId,
  createInvitationToken,
  getInviteTtlHours,
  hashInvitationToken,
  normalizeEmail,
  slugify,
} from "@/lib/workspaces/tokens"
import type {
  Invitation,
  InvitationStatus,
  Membership,
  Workspace,
  WorkspaceRole,
  WorkspaceUser,
} from "@/lib/workspaces/types"

export type StoredUser = WorkspaceUser & {
  defaultWorkspaceId?: string
  disabledAt?: string
  lastLoginAt?: string
}

export type MembershipWithWorkspace = Membership & { workspace: Workspace }

export type MemberWithUser = Membership & { user: WorkspaceUser }

export type InvitableRole = Exclude<WorkspaceRole, "owner">

export type WorkspaceStoreErrorCode =
  | "not_found"
  | "last_owner"
  | "already_member"
  | "invitation_invalid"
  | "email_mismatch"
  | "invalid"

const ERROR_STATUS: Record<WorkspaceStoreErrorCode, number> = {
  not_found: 404,
  last_owner: 409,
  already_member: 409,
  invitation_invalid: 410,
  email_mismatch: 403,
  invalid: 400,
}

export class WorkspaceStoreError extends Error {
  readonly code: WorkspaceStoreErrorCode
  readonly status: number

  constructor(code: WorkspaceStoreErrorCode, message: string) {
    super(message)
    this.name = "WorkspaceStoreError"
    this.code = code
    this.status = ERROR_STATUS[code]
  }
}

export type WorkspaceStore = {
  getUserById(id: string): Promise<StoredUser | undefined>
  getUserByEmail(email: string): Promise<StoredUser | undefined>
  /** Create or refresh a user by (lowercased) email. `login` stamps last_login_at. */
  upsertUser(input: {
    email: string
    name?: string
    picture?: string
    login?: boolean
  }): Promise<StoredUser>
  setDefaultWorkspace(userId: string, workspaceId: string): Promise<void>

  getWorkspace(id: string): Promise<Workspace | undefined>
  /** Memberships of live workspaces, oldest first. */
  listMembershipsForUser(userId: string): Promise<MembershipWithWorkspace[]>
  getMembership(workspaceId: string, userId: string): Promise<Membership | undefined>
  /** Creates the workspace and makes the creator its owner. */
  createWorkspace(input: { name: string; createdByUserId: string }): Promise<Workspace>
  updateWorkspace(
    id: string,
    patch: { name?: string; googleSubject?: string | null }
  ): Promise<Workspace>

  listMembers(workspaceId: string): Promise<MemberWithUser[]>
  /** Changes a role; refuses to remove the last owner. */
  setMemberRole(input: {
    workspaceId: string
    userId: string
    role: WorkspaceRole
  }): Promise<Membership>
  /** Removes a membership; refuses to remove the last owner. */
  removeMember(input: { workspaceId: string; userId: string }): Promise<Membership>

  /** New pending invitation (revokes an older pending one for the same email). */
  createInvitation(input: {
    workspaceId: string
    email: string
    role: InvitableRole
    invitedByUserId?: string
    ttlHours?: number
  }): Promise<{ invitation: Invitation; token: string }>
  listInvitations(workspaceId: string): Promise<Invitation[]>
  getInvitation(workspaceId: string, id: string): Promise<Invitation | undefined>
  revokeInvitation(workspaceId: string, id: string): Promise<Invitation>
  /** Fresh token + expiry for a pending invitation (resend). */
  rotateInvitationToken(
    workspaceId: string,
    id: string,
    ttlHours?: number
  ): Promise<{ invitation: Invitation; token: string }>
  recordInvitationSend(id: string, result: { error?: string | null }): Promise<void>
  findInvitationByToken(
    token: string
  ): Promise<{ invitation: Invitation; workspace: Workspace } | undefined>
  /** Accepts for `user` (email must match). Idempotent for the same user. */
  acceptInvitation(input: {
    token: string
    user: Pick<WorkspaceUser, "id" | "email">
  }): Promise<{ membership: Membership; workspace: Workspace; invitation: Invitation }>

  /** Allowlist bootstrap of ws_default (lib/workspaces/bootstrap.ts). */
  ensureBootstrap(env?: NodeJS.ProcessEnv): Promise<void>
}

const INVITABLE_ROLES: readonly InvitableRole[] = ["admin", "member", "viewer"]

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === "owner" || INVITABLE_ROLES.includes(value as InvitableRole)
}

export function isInvitableRole(value: unknown): value is InvitableRole {
  return INVITABLE_ROLES.includes(value as InvitableRole)
}

function effectiveStatus(
  status: InvitationStatus,
  expiresAt: string,
  now = Date.now()
): InvitationStatus {
  return status === "pending" && Date.parse(expiresAt) <= now ? "expired" : status
}

function expiryFrom(ttlHours: number | undefined): string {
  const hours = ttlHours ?? getInviteTtlHours()

  return new Date(Date.now() + hours * 3_600_000).toISOString()
}

function requireName(name: string): string {
  const trimmed = name.trim()

  if (!trimmed || trimmed.length > 120) {
    throw new WorkspaceStoreError("invalid", "Workspace name must be 1-120 characters")
  }

  return trimmed
}

// ---------------------------------------------------------------------------
// In-memory implementation (demo storage and tests)
// ---------------------------------------------------------------------------

type MemoryInvitation = Invitation & { tokenHash: string }

export function createInMemoryWorkspaceStore(
  options: { seedDefaultWorkspace?: boolean } = {}
): WorkspaceStore {
  const users = new Map<string, StoredUser>()
  const workspaces = new Map<string, Workspace & { deleted?: boolean }>()
  const memberships = new Map<string, Membership>()
  const invitations = new Map<string, MemoryInvitation>()
  let sequence = 0

  const nowIso = () => new Date(Date.now() + sequence++).toISOString()
  const membershipKey = (workspaceId: string, userId: string) =>
    `${workspaceId}\u0000${userId}`

  if (options.seedDefaultWorkspace ?? true) {
    workspaces.set(DEFAULT_WORKSPACE_ID, {
      id: DEFAULT_WORKSPACE_ID,
      name: "MeetSum",
      slug: "default",
    })
  }

  const publicWorkspace = (workspace: Workspace & { deleted?: boolean }): Workspace => ({
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    ...(workspace.googleSubject ? { googleSubject: workspace.googleSubject } : {}),
  })

  const publicInvitation = (invitation: MemoryInvitation): Invitation => {
    const { tokenHash, ...rest } = invitation
    void tokenHash

    return { ...rest, status: effectiveStatus(rest.status, rest.expiresAt) }
  }

  const liveWorkspace = (id: string) => {
    const workspace = workspaces.get(id)

    return workspace && !workspace.deleted ? workspace : undefined
  }

  const ownerCount = (workspaceId: string) =>
    [...memberships.values()].filter(
      (membership) => membership.workspaceId === workspaceId && membership.role === "owner"
    ).length

  const upsertMembership = (membership: Membership, overwrite: boolean) => {
    const key = membershipKey(membership.workspaceId, membership.userId)
    const existing = memberships.get(key)

    if (existing && !overwrite) return existing

    const stamp = nowIso()
    const next = {
      ...membership,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
    }

    memberships.set(key, next)

    return next
  }

  const store: WorkspaceStore = {
    async getUserById(id) {
      return users.get(id)
    },

    async getUserByEmail(email) {
      const normalized = normalizeEmail(email)

      return [...users.values()].find((user) => user.email === normalized)
    },

    async upsertUser(input) {
      const email = normalizeEmail(input.email)
      const existing = await store.getUserByEmail(email)
      const user: StoredUser = {
        ...(existing ?? { id: createId("usr"), email }),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.picture !== undefined ? { picture: input.picture } : {}),
        ...(input.login ? { lastLoginAt: nowIso() } : {}),
      }

      users.set(user.id, user)

      return user
    },

    async setDefaultWorkspace(userId, workspaceId) {
      const user = users.get(userId)

      if (user) users.set(userId, { ...user, defaultWorkspaceId: workspaceId })
    },

    async getWorkspace(id) {
      const workspace = liveWorkspace(id)

      return workspace ? publicWorkspace(workspace) : undefined
    },

    async listMembershipsForUser(userId) {
      return [...memberships.values()]
        .filter((membership) => membership.userId === userId)
        .flatMap((membership) => {
          const workspace = liveWorkspace(membership.workspaceId)

          return workspace ? [{ ...membership, workspace: publicWorkspace(workspace) }] : []
        })
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    },

    async getMembership(workspaceId, userId) {
      return liveWorkspace(workspaceId)
        ? memberships.get(membershipKey(workspaceId, userId))
        : undefined
    },

    async createWorkspace(input) {
      const name = requireName(input.name)
      const slugBase = slugify(name)
      let slug = slugBase
      let suffix = 1

      while ([...workspaces.values()].some((workspace) => workspace.slug === slug)) {
        slug = `${slugBase}-${++suffix}`
      }

      const workspace: Workspace = { id: createId("ws"), name, slug }

      workspaces.set(workspace.id, workspace)
      upsertMembership(
        { workspaceId: workspace.id, userId: input.createdByUserId, role: "owner" },
        true
      )

      return workspace
    },

    async updateWorkspace(id, patch) {
      const workspace = liveWorkspace(id)

      if (!workspace) throw new WorkspaceStoreError("not_found", "Workspace not found")

      const next = { ...workspace }

      if (patch.name !== undefined) next.name = requireName(patch.name)
      if (patch.googleSubject !== undefined) {
        if (patch.googleSubject) next.googleSubject = normalizeEmail(patch.googleSubject)
        else delete next.googleSubject
      }

      workspaces.set(id, next)

      return publicWorkspace(next)
    },

    async listMembers(workspaceId) {
      return [...memberships.values()]
        .filter((membership) => membership.workspaceId === workspaceId)
        .flatMap((membership) => {
          const user = users.get(membership.userId)

          return user
            ? [
                {
                  ...membership,
                  user: {
                    id: user.id,
                    email: user.email,
                    ...(user.name ? { name: user.name } : {}),
                    ...(user.picture ? { picture: user.picture } : {}),
                  },
                },
              ]
            : []
        })
        .sort((left, right) => roleRank(right.role) - roleRank(left.role))
    },

    async setMemberRole(input) {
      const key = membershipKey(input.workspaceId, input.userId)
      const existing = memberships.get(key)

      if (!existing) throw new WorkspaceStoreError("not_found", "Member not found")
      if (
        existing.role === "owner" &&
        input.role !== "owner" &&
        ownerCount(input.workspaceId) <= 1
      ) {
        throw new WorkspaceStoreError("last_owner", "A workspace needs at least one owner")
      }

      return upsertMembership({ ...existing, role: input.role }, true)
    },

    async removeMember(input) {
      const key = membershipKey(input.workspaceId, input.userId)
      const existing = memberships.get(key)

      if (!existing) throw new WorkspaceStoreError("not_found", "Member not found")
      if (existing.role === "owner" && ownerCount(input.workspaceId) <= 1) {
        throw new WorkspaceStoreError("last_owner", "A workspace needs at least one owner")
      }

      memberships.delete(key)

      return existing
    },

    async createInvitation(input) {
      const email = normalizeEmail(input.email)

      for (const invitation of invitations.values()) {
        if (
          invitation.workspaceId === input.workspaceId &&
          invitation.email === email &&
          invitation.status === "pending"
        ) {
          invitations.set(invitation.id, {
            ...invitation,
            status: "revoked",
            updatedAt: nowIso(),
          })
        }
      }

      const token = createInvitationToken()
      const stamp = nowIso()
      const invitation: MemoryInvitation = {
        id: createId("inv"),
        workspaceId: input.workspaceId,
        email,
        role: input.role,
        status: "pending",
        ...(input.invitedByUserId ? { invitedByUserId: input.invitedByUserId } : {}),
        expiresAt: expiryFrom(input.ttlHours),
        sendCount: 0,
        createdAt: stamp,
        updatedAt: stamp,
        tokenHash: hashInvitationToken(token),
      }

      invitations.set(invitation.id, invitation)

      return { invitation: publicInvitation(invitation), token }
    },

    async listInvitations(workspaceId) {
      return [...invitations.values()]
        .filter((invitation) => invitation.workspaceId === workspaceId)
        .map(publicInvitation)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    },

    async getInvitation(workspaceId, id) {
      const invitation = invitations.get(id)

      return invitation && invitation.workspaceId === workspaceId
        ? publicInvitation(invitation)
        : undefined
    },

    async revokeInvitation(workspaceId, id) {
      const invitation = invitations.get(id)

      if (!invitation || invitation.workspaceId !== workspaceId) {
        throw new WorkspaceStoreError("not_found", "Invitation not found")
      }
      if (invitation.status !== "pending") {
        throw new WorkspaceStoreError("invitation_invalid", "Invitation is not pending")
      }

      const next = { ...invitation, status: "revoked" as const, updatedAt: nowIso() }

      invitations.set(id, next)

      return publicInvitation(next)
    },

    async rotateInvitationToken(workspaceId, id, ttlHours) {
      const invitation = invitations.get(id)

      if (!invitation || invitation.workspaceId !== workspaceId) {
        throw new WorkspaceStoreError("not_found", "Invitation not found")
      }
      if (invitation.status !== "pending") {
        throw new WorkspaceStoreError("invitation_invalid", "Invitation is not pending")
      }

      const token = createInvitationToken()
      const next: MemoryInvitation = {
        ...invitation,
        tokenHash: hashInvitationToken(token),
        expiresAt: expiryFrom(ttlHours),
        updatedAt: nowIso(),
      }

      invitations.set(id, next)

      return { invitation: publicInvitation(next), token }
    },

    async recordInvitationSend(id, result) {
      const invitation = invitations.get(id)

      if (!invitation) return

      const stamp = nowIso()
      const next: MemoryInvitation = {
        ...invitation,
        lastSentAt: stamp,
        sendCount: invitation.sendCount + 1,
        updatedAt: stamp,
      }

      if (result.error) next.lastSendError = result.error
      else delete next.lastSendError

      invitations.set(id, next)
    },

    async findInvitationByToken(token) {
      const hash = hashInvitationToken(token)
      const invitation = [...invitations.values()].find((item) => item.tokenHash === hash)
      const workspace = invitation ? liveWorkspace(invitation.workspaceId) : undefined

      return invitation && workspace
        ? { invitation: publicInvitation(invitation), workspace: publicWorkspace(workspace) }
        : undefined
    },

    async acceptInvitation(input) {
      const hash = hashInvitationToken(input.token)
      const invitation = [...invitations.values()].find((item) => item.tokenHash === hash)
      const workspace = invitation ? liveWorkspace(invitation.workspaceId) : undefined

      if (!invitation || !workspace) {
        throw new WorkspaceStoreError("not_found", "Invitation not found")
      }

      if (invitation.status === "accepted") {
        const membership = memberships.get(membershipKey(invitation.workspaceId, input.user.id))

        if (invitation.acceptedByUserId === input.user.id && membership) {
          return {
            membership,
            workspace: publicWorkspace(workspace),
            invitation: publicInvitation(invitation),
          }
        }

        throw new WorkspaceStoreError("invitation_invalid", "Invitation was already used")
      }

      if (effectiveStatus(invitation.status, invitation.expiresAt) !== "pending") {
        throw new WorkspaceStoreError("invitation_invalid", "Invitation is no longer valid")
      }
      if (normalizeEmail(input.user.email) !== invitation.email) {
        throw new WorkspaceStoreError("email_mismatch", "Invitation is for a different email")
      }

      const membership = upsertMembership(
        {
          workspaceId: invitation.workspaceId,
          userId: input.user.id,
          role: invitation.role,
          ...(invitation.invitedByUserId ? { invitedByUserId: invitation.invitedByUserId } : {}),
        },
        false
      )
      const stamp = nowIso()
      const accepted: MemoryInvitation = {
        ...invitation,
        status: "accepted",
        acceptedByUserId: input.user.id,
        acceptedAt: stamp,
        updatedAt: stamp,
      }

      invitations.set(invitation.id, accepted)
      await store.setDefaultWorkspace(input.user.id, invitation.workspaceId)

      return {
        membership,
        workspace: publicWorkspace(workspace),
        invitation: publicInvitation(accepted),
      }
    },

    async ensureBootstrap(env = process.env) {
      const { owner, subject, emails } = resolveBootstrapIdentities(env)

      if (!owner) return

      if (!workspaces.has(DEFAULT_WORKSPACE_ID)) {
        workspaces.set(DEFAULT_WORKSPACE_ID, {
          id: DEFAULT_WORKSPACE_ID,
          name: "MeetSum",
          slug: "default",
        })
      }

      const ids: Record<string, string> = {}

      for (const email of emails) ids[email] = (await store.upsertUser({ email })).id

      if (ownerCount(DEFAULT_WORKSPACE_ID) === 0) {
        upsertMembership(
          { workspaceId: DEFAULT_WORKSPACE_ID, userId: ids[owner], role: "owner" },
          true
        )
      }

      for (const email of emails) {
        upsertMembership(
          { workspaceId: DEFAULT_WORKSPACE_ID, userId: ids[email], role: "admin" },
          false
        )
        const user = users.get(ids[email])

        if (user && !user.defaultWorkspaceId) {
          users.set(user.id, { ...user, defaultWorkspaceId: DEFAULT_WORKSPACE_ID })
        }
      }

      const workspace = workspaces.get(DEFAULT_WORKSPACE_ID)

      if (subject && workspace && !workspace.googleSubject) {
        workspaces.set(DEFAULT_WORKSPACE_ID, { ...workspace, googleSubject: subject })
      }
    },
  }

  return store
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

/** A pool (with `connect` for transactions) or a single client. */
export type WorkspaceDb = Queryable & {
  connect?: () => Promise<Queryable & { release: () => void }>
}

async function withTransaction<T>(
  db: WorkspaceDb,
  run: (client: Queryable) => Promise<T>
): Promise<T> {
  const client = db.connect ? await db.connect() : undefined
  const runner: Queryable = client ?? db

  try {
    await runner.query("begin")
    const result = await run(runner)

    await runner.query("commit")

    return result
  } catch (error) {
    await runner.query("rollback").catch(() => {})
    throw error
  } finally {
    client?.release()
  }
}

type Row = Record<string, unknown>

function iso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (value instanceof Date) return value.toISOString()

  return String(value)
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined || value === "" ? undefined : String(value)
}

function mapUser(row: Row): StoredUser {
  const user: StoredUser = { id: String(row.id), email: String(row.email) }
  const name = optionalString(row.name ?? row.display_name)
  const picture = optionalString(row.picture_url)
  const defaultWorkspaceId = optionalString(row.default_workspace_id)
  const disabledAt = iso(row.disabled_at)
  const lastLoginAt = iso(row.last_login_at)

  if (name) user.name = name
  if (picture) user.picture = picture
  if (defaultWorkspaceId) user.defaultWorkspaceId = defaultWorkspaceId
  if (disabledAt) user.disabledAt = disabledAt
  if (lastLoginAt) user.lastLoginAt = lastLoginAt

  return user
}

function mapWorkspace(row: Row, prefix = ""): Workspace {
  const workspace: Workspace = {
    id: String(row[`${prefix}id`]),
    name: String(row[`${prefix}name`]),
    slug: String(row[`${prefix}slug`]),
  }
  const googleSubject = optionalString(row[`${prefix}google_subject`])

  if (googleSubject) workspace.googleSubject = googleSubject

  return workspace
}

function mapMembership(row: Row): Membership {
  const membership: Membership = {
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    role: String(row.role) as WorkspaceRole,
  }
  const invitedBy = optionalString(row.invited_by_user_id)

  if (invitedBy) membership.invitedByUserId = invitedBy
  membership.createdAt = iso(row.created_at)
  membership.updatedAt = iso(row.updated_at)

  return membership
}

function mapInvitation(row: Row): Invitation {
  const expiresAt = iso(row.expires_at) ?? ""
  const invitation: Invitation = {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    email: String(row.email),
    role: String(row.role) as InvitableRole,
    status: effectiveStatus(String(row.status) as InvitationStatus, expiresAt),
    expiresAt,
    sendCount: Number(row.send_count ?? 0),
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  }
  const optional: Array<[keyof Invitation, unknown]> = [
    ["invitedByUserId", optionalString(row.invited_by_user_id)],
    ["acceptedByUserId", optionalString(row.accepted_by_user_id)],
    ["acceptedAt", iso(row.accepted_at)],
    ["lastSentAt", iso(row.last_sent_at)],
    ["lastSendError", optionalString(row.last_send_error)],
  ]

  for (const [key, value] of optional) {
    if (value !== undefined) Object.assign(invitation, { [key]: value })
  }

  return invitation
}

const INVITATION_COLUMNS = `i.id, i.workspace_id, i.email, i.role, i.status,
  i.invited_by_user_id, i.accepted_by_user_id, i.expires_at, i.accepted_at,
  i.last_sent_at, i.send_count, i.last_send_error, i.created_at, i.updated_at`

const LIVE_WORKSPACE_COLUMNS = `w.id as w_id, w.name as w_name, w.slug as w_slug,
  w.google_subject as w_google_subject`

export function createPostgresWorkspaceStore(db: WorkspaceDb): WorkspaceStore {
  const first = async (text: string, values: unknown[], client: Queryable = db) =>
    (await client.query(text, values)).rows[0] as Row | undefined

  async function lockLastOwner(
    client: Queryable,
    workspaceId: string,
    userId: string
  ): Promise<Membership> {
    // Lock every owner row of the workspace so concurrent demotions cannot
    // both pass the "another owner exists" check.
    const owners = (
      await client.query(
        `select workspace_id, user_id, role, invited_by_user_id, created_at, updated_at
         from memberships
         where workspace_id = $1 and role = 'owner'
         for update`,
        [workspaceId]
      )
    ).rows as Row[]
    const target = await first(
      `select workspace_id, user_id, role, invited_by_user_id, created_at, updated_at
       from memberships
       where workspace_id = $1 and user_id = $2
       for update`,
      [workspaceId, userId],
      client
    )

    if (!target) throw new WorkspaceStoreError("not_found", "Member not found")

    const membership = mapMembership(target)

    return Object.assign(membership, { ownerCount: owners.length })
  }

  const store: WorkspaceStore = {
    async getUserById(id) {
      const row = await first(`select * from users where id = $1`, [id])

      return row ? mapUser(row) : undefined
    },

    async getUserByEmail(email) {
      const row = await first(`select * from users where lower(email) = $1`, [
        normalizeEmail(email),
      ])

      return row ? mapUser(row) : undefined
    },

    async upsertUser(input) {
      const row = await first(
        `insert into users (id, email, name, picture_url, last_login_at)
         values ($1, $2, $3, $4, case when $5::boolean then now() else null end)
         on conflict (email) do update set
           name = coalesce(excluded.name, users.name),
           picture_url = coalesce(excluded.picture_url, users.picture_url),
           last_login_at = case when $5::boolean then now() else users.last_login_at end,
           updated_at = now()
         returning *`,
        [
          createId("usr"),
          normalizeEmail(input.email),
          input.name ?? null,
          input.picture ?? null,
          Boolean(input.login),
        ]
      )

      return mapUser(row as Row)
    },

    async setDefaultWorkspace(userId, workspaceId) {
      await db.query(
        `update users set default_workspace_id = $2, updated_at = now() where id = $1`,
        [userId, workspaceId]
      )
    },

    async getWorkspace(id) {
      const row = await first(
        `select id, name, slug, google_subject from workspaces
         where id = $1 and deleted_at is null`,
        [id]
      )

      return row ? mapWorkspace(row) : undefined
    },

    async listMembershipsForUser(userId) {
      const result = await db.query(
        `select m.workspace_id, m.user_id, m.role, m.invited_by_user_id,
           m.created_at, m.updated_at, ${LIVE_WORKSPACE_COLUMNS}
         from memberships m
         join workspaces w on w.id = m.workspace_id and w.deleted_at is null
         where m.user_id = $1
         order by m.created_at asc, m.workspace_id asc`,
        [userId]
      )

      return (result.rows as Row[]).map((row) => ({
        ...mapMembership(row),
        workspace: mapWorkspace(row, "w_"),
      }))
    },

    async getMembership(workspaceId, userId) {
      const row = await first(
        `select m.* from memberships m
         join workspaces w on w.id = m.workspace_id and w.deleted_at is null
         where m.workspace_id = $1 and m.user_id = $2`,
        [workspaceId, userId]
      )

      return row ? mapMembership(row) : undefined
    },

    async createWorkspace(input) {
      const name = requireName(input.name)

      return withTransaction(db, async (client) => {
        const id = createId("ws")
        const slug = `${slugify(name)}-${id.slice(-6)}`
        const row = await first(
          `insert into workspaces (id, name, slug, created_by_user_id)
           values ($1, $2, $3, $4)
           returning id, name, slug, google_subject`,
          [id, name, slug, input.createdByUserId],
          client
        )

        await client.query(
          `insert into memberships (workspace_id, user_id, role)
           values ($1, $2, 'owner')`,
          [id, input.createdByUserId]
        )

        return mapWorkspace(row as Row)
      })
    },

    async updateWorkspace(id, patch) {
      const sets: string[] = []
      const values: unknown[] = [id]

      if (patch.name !== undefined) {
        values.push(requireName(patch.name))
        sets.push(`name = $${values.length}`)
      }
      if (patch.googleSubject !== undefined) {
        values.push(patch.googleSubject ? normalizeEmail(patch.googleSubject) : null)
        sets.push(`google_subject = $${values.length}`)
      }

      const row = await first(
        `update workspaces set ${[...sets, "updated_at = now()"].join(", ")}
         where id = $1 and deleted_at is null
         returning id, name, slug, google_subject`,
        values
      )

      if (!row) throw new WorkspaceStoreError("not_found", "Workspace not found")

      return mapWorkspace(row)
    },

    async listMembers(workspaceId) {
      const result = await db.query(
        `select m.workspace_id, m.user_id, m.role, m.invited_by_user_id,
           m.created_at, m.updated_at,
           u.id as u_id, u.email as u_email, u.name as u_name,
           u.display_name as u_display_name, u.picture_url as u_picture_url
         from memberships m
         join users u on u.id = m.user_id
         where m.workspace_id = $1
         order by case m.role when 'owner' then 0 when 'admin' then 1
           when 'member' then 2 else 3 end, lower(u.email)`,
        [workspaceId]
      )

      return (result.rows as Row[]).map((row) => {
        const name = optionalString(row.u_name ?? row.u_display_name)
        const picture = optionalString(row.u_picture_url)

        return {
          ...mapMembership(row),
          user: {
            id: String(row.u_id),
            email: String(row.u_email),
            ...(name ? { name } : {}),
            ...(picture ? { picture } : {}),
          },
        }
      })
    },

    async setMemberRole(input) {
      return withTransaction(db, async (client) => {
        const target = (await lockLastOwner(client, input.workspaceId, input.userId)) as Membership & {
          ownerCount: number
        }

        if (target.role === "owner" && input.role !== "owner" && target.ownerCount <= 1) {
          throw new WorkspaceStoreError("last_owner", "A workspace needs at least one owner")
        }

        const row = await first(
          `update memberships set role = $3, updated_at = now()
           where workspace_id = $1 and user_id = $2
           returning *`,
          [input.workspaceId, input.userId, input.role],
          client
        )

        return mapMembership(row as Row)
      })
    },

    async removeMember(input) {
      return withTransaction(db, async (client) => {
        const target = (await lockLastOwner(client, input.workspaceId, input.userId)) as Membership & {
          ownerCount: number
        }

        if (target.role === "owner" && target.ownerCount <= 1) {
          throw new WorkspaceStoreError("last_owner", "A workspace needs at least one owner")
        }

        await client.query(
          `delete from memberships where workspace_id = $1 and user_id = $2`,
          [input.workspaceId, input.userId]
        )

        const { ownerCount, ...membership } = target
        void ownerCount

        return membership
      })
    },

    async createInvitation(input) {
      const email = normalizeEmail(input.email)
      const token = createInvitationToken()

      return withTransaction(db, async (client) => {
        await client.query(
          `update invitations set status = 'revoked', updated_at = now()
           where workspace_id = $1 and lower(email) = $2 and status = 'pending'`,
          [input.workspaceId, email]
        )

        const row = await first(
          `insert into invitations as i (
             id, workspace_id, email, role, token_hash, invited_by_user_id, expires_at
           )
           values ($1, $2, $3, $4, $5, $6, $7)
           returning ${INVITATION_COLUMNS}`,
          [
            createId("inv"),
            input.workspaceId,
            email,
            input.role,
            hashInvitationToken(token),
            input.invitedByUserId ?? null,
            expiryFrom(input.ttlHours),
          ],
          client
        )

        return { invitation: mapInvitation(row as Row), token }
      })
    },

    async listInvitations(workspaceId) {
      const result = await db.query(
        `select ${INVITATION_COLUMNS} from invitations i
         where i.workspace_id = $1
         order by i.created_at desc
         limit 500`,
        [workspaceId]
      )

      return (result.rows as Row[]).map(mapInvitation)
    },

    async getInvitation(workspaceId, id) {
      const row = await first(
        `select ${INVITATION_COLUMNS} from invitations i
         where i.id = $1 and i.workspace_id = $2`,
        [id, workspaceId]
      )

      return row ? mapInvitation(row) : undefined
    },

    async revokeInvitation(workspaceId, id) {
      const row = await first(
        `update invitations i set status = 'revoked', updated_at = now()
         where i.id = $1 and i.workspace_id = $2 and i.status = 'pending'
         returning ${INVITATION_COLUMNS}`,
        [id, workspaceId]
      )

      if (row) return mapInvitation(row)
      if (await store.getInvitation(workspaceId, id)) {
        throw new WorkspaceStoreError("invitation_invalid", "Invitation is not pending")
      }

      throw new WorkspaceStoreError("not_found", "Invitation not found")
    },

    async rotateInvitationToken(workspaceId, id, ttlHours) {
      const token = createInvitationToken()
      const row = await first(
        `update invitations i
         set token_hash = $3, expires_at = $4, updated_at = now()
         where i.id = $1 and i.workspace_id = $2 and i.status = 'pending'
         returning ${INVITATION_COLUMNS}`,
        [id, workspaceId, hashInvitationToken(token), expiryFrom(ttlHours)]
      )

      if (row) return { invitation: mapInvitation(row), token }
      if (await store.getInvitation(workspaceId, id)) {
        throw new WorkspaceStoreError("invitation_invalid", "Invitation is not pending")
      }

      throw new WorkspaceStoreError("not_found", "Invitation not found")
    },

    async recordInvitationSend(id, result) {
      await db.query(
        `update invitations
         set last_sent_at = now(), send_count = send_count + 1,
           last_send_error = $2, updated_at = now()
         where id = $1`,
        [id, result.error ? String(result.error).slice(0, 500) : null]
      )
    },

    async findInvitationByToken(token) {
      const row = await first(
        `select ${INVITATION_COLUMNS}, ${LIVE_WORKSPACE_COLUMNS}
         from invitations i
         join workspaces w on w.id = i.workspace_id and w.deleted_at is null
         where i.token_hash = $1`,
        [hashInvitationToken(token)]
      )

      return row
        ? { invitation: mapInvitation(row), workspace: mapWorkspace(row, "w_") }
        : undefined
    },

    async acceptInvitation(input) {
      return withTransaction(db, async (client) => {
        const row = await first(
          `select ${INVITATION_COLUMNS}, ${LIVE_WORKSPACE_COLUMNS}
           from invitations i
           join workspaces w on w.id = i.workspace_id and w.deleted_at is null
           where i.token_hash = $1
           for update of i`,
          [hashInvitationToken(input.token)],
          client
        )

        if (!row) throw new WorkspaceStoreError("not_found", "Invitation not found")

        const invitation = mapInvitation(row)
        const workspace = mapWorkspace(row, "w_")

        if (invitation.status === "accepted") {
          const existing = await first(
            `select * from memberships where workspace_id = $1 and user_id = $2`,
            [invitation.workspaceId, input.user.id],
            client
          )

          if (invitation.acceptedByUserId === input.user.id && existing) {
            return { membership: mapMembership(existing), workspace, invitation }
          }

          throw new WorkspaceStoreError("invitation_invalid", "Invitation was already used")
        }

        if (invitation.status !== "pending") {
          throw new WorkspaceStoreError("invitation_invalid", "Invitation is no longer valid")
        }
        if (normalizeEmail(input.user.email) !== normalizeEmail(invitation.email)) {
          throw new WorkspaceStoreError("email_mismatch", "Invitation is for a different email")
        }

        // Never downgrade an existing membership.
        await client.query(
          `insert into memberships (workspace_id, user_id, role, invited_by_user_id)
           values ($1, $2, $3, $4)
           on conflict (workspace_id, user_id) do nothing`,
          [
            invitation.workspaceId,
            input.user.id,
            invitation.role,
            invitation.invitedByUserId ?? null,
          ]
        )

        const membership = await first(
          `select * from memberships where workspace_id = $1 and user_id = $2`,
          [invitation.workspaceId, input.user.id],
          client
        )
        const accepted = await first(
          `update invitations i
           set status = 'accepted', accepted_by_user_id = $2, accepted_at = now(),
             updated_at = now()
           where i.id = $1
           returning ${INVITATION_COLUMNS}`,
          [invitation.id, input.user.id],
          client
        )

        await client.query(
          `update users set default_workspace_id = $2, updated_at = now() where id = $1`,
          [input.user.id, invitation.workspaceId]
        )

        return {
          membership: mapMembership(membership as Row),
          workspace,
          invitation: mapInvitation(accepted as Row),
        }
      })
    },

    async ensureBootstrap(env = process.env) {
      await ensureBootstrapWorkspace(db, env)
    },
  }

  return store
}

// ---------------------------------------------------------------------------
// Process-wide store
// ---------------------------------------------------------------------------

// Kept on globalThis so every route bundle in one server process shares the
// same (in-memory demo) store.
const STORE_KEY = Symbol.for("meetsum.workspaceStore")
type StoreHolder = { [STORE_KEY]?: WorkspaceStore }

export function getWorkspaceStore(env: NodeJS.ProcessEnv = process.env): WorkspaceStore {
  const holder = globalThis as StoreHolder
  const cached = holder[STORE_KEY]

  if (cached) return cached

  // Lazy import keeps `pg` out of non-postgres code paths and tests.
  const store =
    env.MEETSUM_STORAGE === "postgres"
      ? createLazyPostgresStore()
      : createInMemoryWorkspaceStore()

  holder[STORE_KEY] = store

  return store
}

/** Test hook: replace (or reset with undefined) the process-wide store. */
export function setWorkspaceStoreForTesting(store: WorkspaceStore | undefined) {
  ;(globalThis as StoreHolder)[STORE_KEY] = store
}

function createLazyPostgresStore(): WorkspaceStore {
  let inner: Promise<WorkspaceStore> | undefined
  const resolve = () =>
    (inner ??= import("@/lib/db/client").then(({ getDatabasePool }) =>
      createPostgresWorkspaceStore(getDatabasePool() as unknown as WorkspaceDb)
    ))

  return new Proxy({} as WorkspaceStore, {
    get(_target, property) {
      // Not a thenable: `await getWorkspaceStore()` must not hang.
      if (property === "then" || typeof property === "symbol") return undefined

      return async (...args: unknown[]) => {
        const store = await resolve()
        const method = Reflect.get(store, property) as (...input: unknown[]) => unknown

        return method.apply(store, args)
      }
    },
  })
}
