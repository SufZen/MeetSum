/**
 * GET/POST /api/onboarding; admin-only steps are `unavailable` for members (docs/parity/m9.md C3).
 * M9 Step 0 stub behind its final guard; owner: Package C.
 */
import { withAuthz } from "@/lib/auth/authz"
import { isUserPrincipal, notImplementedResponse, userRequiredResponse } from "@/lib/http/m9-stubs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withAuthz("workspace:read", async (_request, ctx) => {
  if (!isUserPrincipal(ctx)) return userRequiredResponse()

  return notImplementedResponse("onboarding")
})

export const POST = withAuthz("workspace:read", async (_request, ctx) => {
  if (!isUserPrincipal(ctx)) return userRequiredResponse()

  return notImplementedResponse("onboarding")
})
