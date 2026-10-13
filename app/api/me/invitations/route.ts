/**
 * GET /api/me/invitations: pending invitations for the session email (docs/parity/m9.md C1).
 * M9 Step 0 stub behind its final guard (withSession rejects API keys);
 * owner: Package C.
 */
import { withSession } from "@/lib/auth/authz"
import { notImplementedResponse } from "@/lib/http/m9-stubs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withSession(async () => notImplementedResponse("invitations"))
