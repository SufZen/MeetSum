import { withAuthz } from "@/lib/auth/authz"
import { joinBotNow } from "@/lib/bot/service"

export const runtime = "nodejs"

/**
 * POST /api/meetings/bot — "Join now": send the meeting bot to a pasted
 * Meet/Zoom/Teams link or invite text (M7 B7). Rate-limited per user
 * (memory) and per workspace (DB); never returns passcodes or raw URLs.
 */
export const POST = withAuthz("meeting:create", (request, ctx) => joinBotNow(request, ctx))
