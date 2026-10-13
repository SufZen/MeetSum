import { withAuthz } from "@/lib/auth/authz"
import { getBotStatusResponse } from "@/lib/bot/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** GET /api/bot/status — Vexa health, running bots and capacity (ops). */
export const GET = withAuthz("ops:read", () => getBotStatusResponse())
