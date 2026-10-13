/**
 * Pending invitations of the signed-in user (docs/parity/m9.md C1,
 * `GET /api/me/invitations`). Only invitations addressed to the session
 * email are returned; on Postgres they are read directly, in demo storage
 * from the user's `invited` notifications. Server-only.
 */
import { getCollabBackend, toIso, type CollabBackend } from "@/lib/clips/db"
import type { MemoryNotificationRow } from "@/lib/notifications/enqueue"
import type { WorkspaceStore } from "@/lib/workspaces/store"
import type { WorkspaceUser } from "@/lib/workspaces/types"

export type MyInvitation = {
  id: string
  workspace: { id: string; name: string }
  role: string
  expiresAt: string
}

const normalize = (email: string) => email.trim().toLowerCase()

async function invitedRefs(
  userId: string,
  backend: Extract<CollabBackend, { kind: "memory" }>
): Promise<Array<{ invitationId: string; workspaceId: string }>> {
  return (backend.db.notifications as MemoryNotificationRow[])
    .filter((row) => row.userId === userId && row.kind === "invited")
    .flatMap((row) =>
      typeof row.payload.invitationId === "string" && typeof row.payload.workspaceId === "string"
        ? [{ invitationId: row.payload.invitationId, workspaceId: row.payload.workspaceId }]
        : []
    )
}

export async function listMyInvitations(
  user: Pick<WorkspaceUser, "id" | "email">,
  store: WorkspaceStore,
  backend?: CollabBackend,
  now: number = Date.now()
): Promise<MyInvitation[]> {
  const target = backend ?? (await getCollabBackend())

  if (target.kind === "postgres") {
    const result = await target.client.query(
      `select i.id, i.workspace_id, w.name as workspace_name, i.role, i.expires_at
       from invitations i join workspaces w on w.id = i.workspace_id and w.deleted_at is null
       where lower(i.email) = $1 and i.status = 'pending' and i.expires_at > now()
       order by i.created_at desc
       limit 50`,
      [normalize(user.email)]
    )

    return (result.rows as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      workspace: { id: String(row.workspace_id), name: String(row.workspace_name) },
      role: String(row.role),
      expiresAt: toIso(row.expires_at) ?? "",
    }))
  }

  const found: MyInvitation[] = []

  for (const ref of await invitedRefs(user.id, target)) {
    const invitation = await store.getInvitation(ref.workspaceId, ref.invitationId)
    const workspace = invitation ? await store.getWorkspace(invitation.workspaceId) : undefined

    if (
      invitation &&
      workspace &&
      invitation.status === "pending" &&
      Date.parse(invitation.expiresAt) > now &&
      normalize(invitation.email) === normalize(user.email) &&
      !found.some((item) => item.id === invitation.id)
    ) {
      found.push({
        id: invitation.id,
        workspace: { id: workspace.id, name: workspace.name },
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      })
    }
  }

  return found
}

/** The workspace of an invitation addressed to `user` (undefined when unknown or not theirs). */
export async function findMyInvitationWorkspace(
  user: Pick<WorkspaceUser, "id" | "email">,
  invitationId: string,
  backend?: CollabBackend
): Promise<string | undefined> {
  const target = backend ?? (await getCollabBackend())

  if (target.kind === "postgres") {
    const result = await target.client.query(`select workspace_id from invitations where id = $1`, [invitationId])
    const row = result.rows[0] as { workspace_id?: string } | undefined

    return row?.workspace_id
  }

  return (await invitedRefs(user.id, target)).find((ref) => ref.invitationId === invitationId)?.workspaceId
}
