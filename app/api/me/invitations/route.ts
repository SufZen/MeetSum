/**
 * GET /api/me/invitations: pending invitations addressed to the session
 * email, in any workspace (docs/parity/m9.md C1). withSession rejects API keys.
 */
import { NextResponse } from "next/server"

import { withSession } from "@/lib/auth/authz"
import { listMyInvitations } from "@/lib/notifications/invitations"
import { getWorkspaceStore } from "@/lib/workspaces/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withSession(async (_request, session) => {
  const invitations = await listMyInvitations(session.user, getWorkspaceStore())

  return NextResponse.json({ invitations }, { headers: { "cache-control": "private, no-store" } })
})
