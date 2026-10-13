/**
 * GET/POST /api/onboarding (docs/parity/m9.md C3). `workspace:read`, user
 * principals only. GET → `{ steps, dismissed, completed }` (admin-only steps
 * are `unavailable` for members); POST `{ action: "skip"|"unskip", step }` or
 * `{ action: "dismiss"|"complete" }` stores the caller's own progress.
 */
import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { isUserPrincipal, userRequiredResponse } from "@/lib/http/m9-stubs"
import { getOnboardingProgressStore, parseOnboardingAction } from "@/lib/onboarding/progress"
import { getOnboardingState } from "@/lib/onboarding/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const NO_STORE = { "cache-control": "private, no-store" }

export const GET = withAuthz("workspace:read", async (_request, ctx) => {
  if (!isUserPrincipal(ctx)) return userRequiredResponse()
  if (!ctx.user) return userRequiredResponse()

  return NextResponse.json(await getOnboardingState(ctx), { headers: NO_STORE })
})

export const POST = withAuthz("workspace:read", async (request, ctx) => {
  if (!isUserPrincipal(ctx)) return userRequiredResponse()
  if (!ctx.user) return userRequiredResponse()

  const action = parseOnboardingAction(await request.json().catch(() => undefined))

  if (!action) return NextResponse.json({ error: "invalid_action" }, { status: 400 })

  const progress = await getOnboardingProgressStore()

  await progress.apply(ctx.workspace.id, ctx.user.id, action)

  return NextResponse.json(await getOnboardingState(ctx, { progress }), { headers: NO_STORE })
})
