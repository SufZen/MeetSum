/**
 * Single source of truth for "which Google Workspace user do we act as".
 *
 * Resolution order:
 *   1. an explicit subject passed by the caller (CLI flag, job payload, API body)
 *   2. `GOOGLE_WORKSPACE_SUBJECT` (falls back to the legacy alias
 *      `GOOGLE_WORKSPACE_ADMIN_EMAIL`)
 *   3. the signed-in session's email
 *   4. otherwise a configuration error — there is no baked-in default identity.
 */

import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"

export class WorkspaceSubjectNotConfiguredError extends Error {
  constructor() {
    super(
      "Google Workspace subject is not configured. Set GOOGLE_WORKSPACE_SUBJECT, pass an explicit subject, or sign in."
    )
    this.name = "WorkspaceSubjectNotConfiguredError"
  }
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()

  return trimmed ? trimmed.toLowerCase() : undefined
}

/** The subject configured through the environment, if any. */
export function getConfiguredWorkspaceSubject(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return (
    clean(env.GOOGLE_WORKSPACE_SUBJECT) ??
    clean(env.GOOGLE_WORKSPACE_ADMIN_EMAIL)
  )
}

/** A workspace has no Google identity to act as (no `google_subject`). */
export class GoogleNotConfiguredError extends Error {
  readonly code = "google_not_configured"

  constructor(workspaceId?: string) {
    super(
      `Google Workspace is not configured for ${workspaceId ? `workspace ${workspaceId}` : "this workspace"}. An owner must set the workspace Google subject.`
    )
    this.name = "GoogleNotConfiguredError"
  }
}

/**
 * The delegated identity of a workspace (M2): `workspaces.google_subject`.
 * The env subject (GOOGLE_WORKSPACE_SUBJECT) is bootstrap-only and applies to
 * the default workspace alone; it is never a fallback for other workspaces.
 */
export function getWorkspaceGoogleSubject(
  workspace: { id: string; googleSubject?: string | null },
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return (
    clean(workspace.googleSubject) ??
    (workspace.id === DEFAULT_WORKSPACE_ID
      ? getConfiguredWorkspaceSubject(env)
      : undefined)
  )
}

/**
 * Loads a workspace's Google subject for background work (worker, jobs).
 * Postgres reads `workspaces.google_subject` of a live workspace; other
 * storage only knows the bootstrap subject of the default workspace.
 */
export async function loadWorkspaceGoogleSubject(
  workspaceId: string,
  options: {
    env?: NodeJS.ProcessEnv
    db?: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }
  } = {}
): Promise<string | undefined> {
  const env = options.env ?? process.env

  if (env.MEETSUM_STORAGE !== "postgres") {
    return getWorkspaceGoogleSubject({ id: workspaceId }, env)
  }

  const db = options.db ?? (await import("@/lib/db/client")).getDatabasePool()
  const result = await db.query(
    `
      select google_subject
      from workspaces
      where id = $1 and deleted_at is null
      limit 1
    `,
    [workspaceId]
  )
  const row = result.rows[0] as { google_subject?: string | null } | undefined

  if (!row) return undefined

  return getWorkspaceGoogleSubject(
    { id: workspaceId, googleSubject: row.google_subject },
    env
  )
}

export function resolveWorkspaceSubject(
  options: {
    explicit?: string | null
    sessionEmail?: string | null
    env?: NodeJS.ProcessEnv
  } = {}
): string {
  const subject =
    clean(options.explicit) ??
    getConfiguredWorkspaceSubject(options.env) ??
    clean(options.sessionEmail)

  if (!subject) {
    throw new WorkspaceSubjectNotConfiguredError()
  }

  return subject
}
