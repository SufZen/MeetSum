/**
 * GET/PATCH /api/me/preferences: locale, time zone and notification mutes (docs/parity/m9.md A1).
 * M9 Step 0 stub behind its final guard (withSession rejects API keys);
 * owner: Package A.
 */
import { withSession } from "@/lib/auth/authz"
import { notImplementedResponse } from "@/lib/http/m9-stubs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withSession(async () => notImplementedResponse("preferences"))

export const PATCH = withSession(async () => notImplementedResponse("preferences"))
