import { withAuthz } from "@/lib/auth/authz"
import { listBotSessions } from "@/lib/bot/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/bot/sessions?active=1 — open bot sessions plus the last 24 h of
 * terminal ones, newest per meeting, only for meetings the caller can see.
 */
export const GET = withAuthz("meeting:read", (request, ctx) => listBotSessions(request, ctx))
