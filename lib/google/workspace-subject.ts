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
