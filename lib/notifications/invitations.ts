/**
 * Pending invitations of the signed-in user (docs/parity/m9.md C1,
 * `GET /api/me/invitations`, `POST /api/me/invitations/[id]/accept`).
 *
 * Only invitations addressed to the session email (the verified identity of
 * the session; case-insensitive exact match on the normalized address, never
 * a request parameter) that are pending and unexpired are ever returned or
 * resolved. A listing exposes the invitation id (needed to accept), the
 * workspace name and the inviter's display name: never the token, the email,
 * other invitees or workspace ids. Lookups for anything else return
 * undefined, so the accept route answers the same 404 whether an id is
 * unknown, someone else's, expired, revoked or already used (no enumeration).
 * On Postgres the table is read directly; in demo storage the candidates are
 * the user's own `invited` notifications. Server-only.
 */
import { getCollabBackend, type CollabBackend } from "@/lib/clips/db"
import type { MemoryNotificationRow } from "@/lib/notifications/enqueue"
import type { WorkspaceStore } from "@/lib/workspaces/store"
import type { WorkspaceUser } from "@/lib/workspaces/types"

export type MyInvitation = {
  id: string
  workspaceName: string
  inviterName: string | null
}

const normalize = (email: string) => email.trim().toLowerCase()

type Candidate = { id: string; workspaceId: string; workspaceName: string; inviterName: string | null }

async function memoryCandidates(
  user: Pick<WorkspaceUser, "id" | "email">,
  store: WorkspaceStore,
  backend: Extract<CollabBackend, { kind: "memory" }>,
  now: number
): Promise<Candidate[]> {
  const refs = (backend.db.notifications as MemoryNotificationRow[])
    .filter((row) => row.userId === user.id && row.kind === "invited")
    .flatMap((row) =>
      typeof row.payload.invitationId === "string" && typeof row.payload.workspaceId === "string"
        ? [{ invitationId: row.payload.invitationId, workspaceId: row.payload.workspaceId }]
        : []
    )
  const found: Candidate[] = []

  for (const ref of refs) {
    const invitation = await store.getInvitation(ref.workspaceId, ref.invitationId)
    const workspace = invitation ? await store.getWorkspace(invitation.workspaceId) : undefined

    if (
      !invitation ||
      !workspace ||
      invitation.status !== "pending" ||
      Date.parse(invitation.expiresAt) <= now ||
      normalize(invitation.email) !== normalize(user.email) ||
      found.some((item) => item.id === invitation.id)
    ) {
      continue
    }

    const inviter = invitation.invitedByUserId ? await store.getUserById(invitation.invitedByUserId) : undefined

    found.push({
      id: invitation.id,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      inviterName: inviter?.name?.trim() || null,
    })
  }

  return found
}

async function postgresCandidates(
  user: Pick<WorkspaceUser, "email">,
  backend: Extract<CollabBackend, { kind: "postgres" }>,
  invitationId?: string
): Promise<Candidate[]> {
  const values: unknown[] = [normalize(user.email)]

  if (invitationId) values.push(invitationId)

  const result = await backend.client.query(
    `select i.id, i.workspace_id, w.name as workspace_name,
       coalesce(nullif(trim(u.name), ''), nullif(trim(u.display_name), '')) as inviter_name
     from invitations i
     join workspaces w on w.id = i.workspace_id and w.deleted_at is null
     left join users u on u.id = i.invited_by_user_id
     where lower(i.email) = $1 and i.status = 'pending' and i.expires_at > now()
       ${invitationId ? "and i.id = $2" : ""}
     order by i.created_at desc
     limit 50`,
    values
  )

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    workspaceName: String(row.workspace_name),
    inviterName: typeof row.inviter_name === "string" ? row.inviter_name : null,
  }))
}

export async function listMyInvitations(
  user: Pick<WorkspaceUser, "id" | "email">,
  store: WorkspaceStore,
  backend?: CollabBackend,
  now: number = Date.now()
): Promise<MyInvitation[]> {
  if (!normalize(user.email)) return []

  const target = backend ?? (await getCollabBackend())
  const candidates =
    target.kind === "postgres" ? await postgresCandidates(user, target) : await memoryCandidates(user, store, target, now)

  return candidates.map(({ id, workspaceName, inviterName }) => ({ id, workspaceName, inviterName }))
}

/**
 * The workspace of a pending, unexpired invitation addressed to `user`;
 * undefined for anything else (unknown, someone else's, expired, revoked,
 * used).
 */
export async function findMyInvitationWorkspace(
  user: Pick<WorkspaceUser, "id" | "email">,
  invitationId: string,
  store: WorkspaceStore,
  backend?: CollabBackend,
  now: number = Date.now()
): Promise<string | undefined> {
  if (!normalize(user.email)) return undefined

  const target = backend ?? (await getCollabBackend())
  const candidates =
    target.kind === "postgres"
      ? await postgresCandidates(user, target, invitationId)
      : await memoryCandidates(user, store, target, now)

  return candidates.find((candidate) => candidate.id === invitationId)?.workspaceId
}
