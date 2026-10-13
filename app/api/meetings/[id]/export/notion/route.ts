import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * POST /api/meetings/:id/export/notion (M8, owner: Package C).
 *
 * The token-in-body export is gone: the Notion token comes only from the
 * workspace's Notion OAuth connection, never from the request or a server
 * fallback. Final guard: `meeting:write` + visible; private meetings need
 * `canManageMeeting`. No admin check. Body `{databaseId?}`; a body carrying a
 * token is refused (400 `token_not_accepted`); no connection → 409
 * `notion_not_connected`. Errors map to fixed codes, never Notion's message.
 *
 * M8 Step 0 stub: answers 501 behind its final guard until Package C lands
 * the connection-backed export (docs/parity/m8.md, C1).
 */
export const POST = withAuthz<{ id: string }>("meeting:write", async () =>
  NextResponse.json({ error: "not_implemented" }, { status: 501 })
)
