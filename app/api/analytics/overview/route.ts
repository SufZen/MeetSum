/**
 * GET /api/analytics/overview?from&to&interval&scope&roomId; byMember only for owner/admin (docs/parity/m9.md C2).
 * M9 Step 0 stub behind its final guard; owner: Package C.
 */
import { withAuthz } from "@/lib/auth/authz"
import { isUserPrincipal, notImplementedResponse, userRequiredResponse } from "@/lib/http/m9-stubs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withAuthz("meeting:read", async (_request, ctx) => {
  if (!isUserPrincipal(ctx)) return userRequiredResponse()

  return notImplementedResponse("analytics")
})
