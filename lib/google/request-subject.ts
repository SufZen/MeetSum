import { NextResponse } from "next/server"

import type { AuthContext } from "@/lib/auth/authz"
import {
  GoogleNotConfiguredError,
  getWorkspaceGoogleSubject,
} from "@/lib/google/workspace-subject"

type SubjectContext = Pick<AuthContext, "workspace" | "user">

function clean(value: string | null | undefined) {
  const trimmed = value?.trim().toLowerCase()

  return trimmed || undefined
}

/**
 * Mailboxes a request may act as with domain-wide delegation: the workspace's
 * Google subject and the signed-in user's own email. API keys have no user,
 * so they can only ever use the workspace subject — an arbitrary subject in a
 * request body would let a caller read someone else's Drive/Meet/Calendar.
 */
export function allowedRequestSubjects(ctx: SubjectContext): string[] {
  return [
    ...new Set(
      [getWorkspaceGoogleSubject(ctx.workspace), ctx.user?.email]
        .map(clean)
        .filter((value): value is string => Boolean(value))
    ),
  ]
}

export function googleNotConfiguredResponse(workspaceId?: string) {
  return NextResponse.json(
    {
      error: "google_not_configured",
      message: new GoogleNotConfiguredError(workspaceId).message,
    },
    { status: 409 }
  )
}

/**
 * Resolve the Google subject for an API request.
 *
 * - An explicit subject is honoured only when it is in
 *   `allowedRequestSubjects(ctx)`; anything else is ignored.
 * - Otherwise the workspace subject, then (unless `requireWorkspaceSubject`)
 *   the signed-in user's own email.
 * - `requireWorkspaceSubject` (workspace-wide syncs) answers 409
 *   `google_not_configured` when the workspace has no Google subject.
 */
export function resolveRequestWorkspaceSubject(
  ctx: SubjectContext,
  explicit?: string | null,
  options: { requireWorkspaceSubject?: boolean } = {}
): { subject: string } | { response: NextResponse } {
  const workspaceSubject = clean(getWorkspaceGoogleSubject(ctx.workspace))

  if (options.requireWorkspaceSubject && !workspaceSubject) {
    return { response: googleNotConfiguredResponse(ctx.workspace.id) }
  }

  const requested = clean(explicit)

  if (requested && allowedRequestSubjects(ctx).includes(requested)) {
    return { subject: requested }
  }

  const subject = workspaceSubject ?? clean(ctx.user?.email)

  if (!subject) {
    return { response: googleNotConfiguredResponse(ctx.workspace.id) }
  }

  return { subject }
}
