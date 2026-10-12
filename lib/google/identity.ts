import { createHash } from "node:crypto"

import { getDatabasePool } from "@/lib/db/client"
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"

/**
 * Who Google work runs as and on behalf of which MeetSum workspace. Every
 * Google sync/import/list function takes one: the subject is the delegated
 * mailbox, the workspace owns everything the run reads or writes.
 */
export type GoogleWorkspaceTarget = {
  subject: string
  workspaceId: string
}

type Queryable = { query: ReturnType<typeof getDatabasePool>["query"] }

/** Pre-M2 workspace account; kept for ws_default so existing rows stay linked. */
export const LEGACY_WORKSPACE_ACCOUNT_ID = "workspace_realization"

function hashed(prefix: string, stable: string) {
  return `${prefix}_${createHash("sha256").update(stable).digest("hex").slice(0, 32)}`
}

function normalizeSubject(subject: string) {
  return subject.trim().toLowerCase()
}

/**
 * One `workspace_accounts` row per MeetSum workspace. Because google_identities
 * is unique per (workspace_account_id, subject_email), two workspaces using
 * the same mailbox get separate identities — and therefore separate sync
 * cursors, calendar events, Drive files and Meet records.
 */
export function workspaceAccountIdFor(workspaceId: string) {
  return workspaceId === DEFAULT_WORKSPACE_ID
    ? LEGACY_WORKSPACE_ACCOUNT_ID
    : `wsacct_${workspaceId}`
}

/** Proposed identity id (the persisted id wins on conflict). */
export function googleIdentityIdFor(target: GoogleWorkspaceTarget) {
  const subject = normalizeSubject(target.subject)

  return target.workspaceId === DEFAULT_WORKSPACE_ID
    ? `gident_${Buffer.from(subject).toString("base64url").slice(0, 40)}`
    : hashed("gident", `${target.workspaceId}:${subject}`)
}

/**
 * Upserts the workspace account + Google identity for `target` and returns
 * the persisted identity id. The identity is stamped with its workspace.
 */
export async function ensureGoogleIdentity(
  target: GoogleWorkspaceTarget,
  db: Queryable = getDatabasePool()
): Promise<string> {
  if (!target.workspaceId) throw new Error("workspaceId is required")

  const subject = normalizeSubject(target.subject)
  const workspaceAccountId = workspaceAccountIdFor(target.workspaceId)

  await db.query(
    `
      insert into workspace_accounts (id, domain, admin_email)
      values ($1, $2, $3)
      on conflict (id) do nothing
    `,
    [workspaceAccountId, subject.split("@")[1] ?? "unknown", subject]
  )

  const proposedId = googleIdentityIdFor(target)
  const result = await db.query(
    `
      insert into google_identities (
        id, workspace_account_id, subject_email, sync_enabled, workspace_id
      )
      values ($1, $2, $3, true, $4)
      on conflict (workspace_account_id, subject_email)
      do update set
        sync_enabled = excluded.sync_enabled,
        workspace_id = excluded.workspace_id
      returning id
    `,
    [proposedId, workspaceAccountId, subject, target.workspaceId]
  )

  return (result.rows[0] as { id?: string } | undefined)?.id ?? proposedId
}
