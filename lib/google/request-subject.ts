import { NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/server"
import {
  WorkspaceSubjectNotConfiguredError,
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
 * Resolve the Workspace subject for an API request: explicit value from the
 * request → GOOGLE_WORKSPACE_SUBJECT → signed-in session email.
 *
 * Returns either the subject or a ready-made 503 response describing the
 * missing configuration.
 */
export async function resolveRequestWorkspaceSubject(
  explicit?: string | null
): Promise<{ subject: string } | { response: NextResponse }> {
  try {
    return {
      subject: resolveWorkspaceSubject({
        explicit,
        sessionEmail: await getSessionEmail(),
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
