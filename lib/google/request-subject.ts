import { NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/server"
import {
  WorkspaceSubjectNotConfiguredError,
  getConfiguredWorkspaceSubject,
  resolveWorkspaceSubject,
} from "@/lib/google/workspace-subject"

async function getSessionEmail(): Promise<string | undefined> {
  try {
    return (await getCurrentSession())?.email
  } catch {
    // API-key requests have no session; a missing session secret is reported
    // by the resolver's configuration error instead.
    return undefined
  }
}

/**
 * A signed-in browser user may only name their own mailbox or the configured
 * workspace subject. Any other explicit subject is dropped: with domain-wide
 * delegation it would let one user read another user's Drive, Meet and
 * Calendar data.
 */
export function allowedExplicitSubject(
  explicit: string | null | undefined,
  sessionEmail: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const requested = explicit?.trim().toLowerCase()

  if (!requested) return undefined

  const permitted = [sessionEmail, getConfiguredWorkspaceSubject(env)]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim().toLowerCase())

  return permitted.includes(requested) ? requested : undefined
}

/**
 * Resolve the Workspace subject for an API request: explicit value from the
 * request → GOOGLE_WORKSPACE_SUBJECT → signed-in session email. Session users
 * are limited by `allowedExplicitSubject`; machine (API-key) callers have no
 * session and keep the explicit override.
 *
 * Returns either the subject or a ready-made 503 response describing the
 * missing configuration.
 */
export async function resolveRequestWorkspaceSubject(
  explicit?: string | null
): Promise<{ subject: string } | { response: NextResponse }> {
  try {
    const sessionEmail = await getSessionEmail()

    return {
      subject: resolveWorkspaceSubject({
        explicit: sessionEmail
          ? allowedExplicitSubject(explicit, sessionEmail)
          : explicit,
        sessionEmail,
      }),
    }
  } catch (error) {
    if (error instanceof WorkspaceSubjectNotConfiguredError) {
      return {
        response: NextResponse.json({ error: error.message }, { status: 503 }),
      }
    }

    throw error
  }
}
