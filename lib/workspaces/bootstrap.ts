import { parseAllowedEmails, getAllowedEmails } from "@/lib/auth/session"
import type { Queryable } from "@/lib/db/client"
import { getConfiguredWorkspaceSubject } from "@/lib/google/workspace-subject"
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"
import { createId } from "@/lib/workspaces/tokens"

export type BootstrapIdentities = {
  /** Owner of ws_default: env Workspace subject, else first allowlisted email. */
  owner?: string
  /** Env Workspace subject (DWD identity), when configured. */
  subject?: string
  /** Every bootstrap email (owner first). */
  emails: string[]
}

export function resolveBootstrapIdentities(
  env: NodeJS.ProcessEnv = process.env
): BootstrapIdentities {
  const subject = getConfiguredWorkspaceSubject(env)
  const allowlisted = parseAllowedEmails(env.MEETSUM_ALLOWED_EMAILS)
  const owner = subject ?? allowlisted[0]
  const emails = [
    ...new Set([...(owner ? [owner] : []), ...allowlisted, ...getAllowedEmails(env)]),
  ]

  return { owner, subject, emails }
}

export function isBootstrapEmail(
  email: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return resolveBootstrapIdentities(env).emails.includes(email.trim().toLowerCase())
}

async function upsertUserId(client: Queryable, email: string): Promise<string> {
  const result = await client.query(
    `insert into users (id, email)
     values ($1, $2)
     on conflict (email) do update set email = excluded.email
     returning id`,
    [createId("usr"), email]
  )

  return String((result.rows[0] as { id: string }).id)
}

/**
 * Idempotent bootstrap of `ws_default` from the environment (M2 spec, A7).
 * Runs after migrations (scripts/migrate.ts) and at login for allowlisted
 * emails. Never downgrades an existing membership.
 */
export async function ensureBootstrapWorkspace(
  client: Queryable,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ ownerUserId?: string; userIds: Record<string, string> }> {
  const { owner, subject, emails } = resolveBootstrapIdentities(env)

  if (!owner) return { userIds: {} }

  await client.query(
    `insert into workspaces (id, name, slug) values ($1, 'MeetSum', 'default')
     on conflict (id) do nothing`,
    [DEFAULT_WORKSPACE_ID]
  )

  const userIds: Record<string, string> = {}

  for (const email of emails) {
    userIds[email] = await upsertUserId(client, email)
  }

  const ownerUserId = userIds[owner]
  const owners = await client.query(
    `select user_id from memberships
     where workspace_id = $1 and role = 'owner'
     limit 1`,
    [DEFAULT_WORKSPACE_ID]
  )

  if (owners.rows.length === 0) {
    // No owner yet: the bootstrap owner becomes owner (an upgrade, never a
    // downgrade, if they already had a membership).
    await client.query(
      `insert into memberships (workspace_id, user_id, role)
       values ($1, $2, 'owner')
       on conflict (workspace_id, user_id)
       do update set role = 'owner', updated_at = now()`,
      [DEFAULT_WORKSPACE_ID, ownerUserId]
    )
  }

  for (const email of emails) {
    await client.query(
      `insert into memberships (workspace_id, user_id, role)
       values ($1, $2, 'admin')
       on conflict (workspace_id, user_id) do nothing`,
      [DEFAULT_WORKSPACE_ID, userIds[email]]
    )
  }

  await client.query(
    `update users set default_workspace_id = $1
     where default_workspace_id is null and id = any($2::text[])`,
    [DEFAULT_WORKSPACE_ID, Object.values(userIds)]
  )

  if (subject) {
    await client.query(
      `update workspaces set google_subject = coalesce(google_subject, $2),
         updated_at = now()
       where id = $1 and google_subject is null`,
      [DEFAULT_WORKSPACE_ID, subject]
    )
    await client.query(
      `update google_identities set workspace_id = $1
       where workspace_id is null and lower(subject_email) = $2`,
      [DEFAULT_WORKSPACE_ID, subject]
    )
  }

  await client.query(
    `update meetings set owner_user_id = $2
     where workspace_id = $1 and owner_user_id is null`,
    [DEFAULT_WORKSPACE_ID, ownerUserId]
  )
  await client.query(
    `insert into meeting_favorites (user_id, meeting_id)
     select $2, id from meetings
     where workspace_id = $1 and is_favorite = true
     on conflict do nothing`,
    [DEFAULT_WORKSPACE_ID, ownerUserId]
  )
  await client.query(
    `update api_keys set created_by_user_id = $2
     where workspace_id = $1 and created_by_user_id is null`,
    [DEFAULT_WORKSPACE_ID, ownerUserId]
  )

  return { ownerUserId, userIds }
}
