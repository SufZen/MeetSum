import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { actorUserId, apiError, auditActor, limitFor, readJsonBody } from "@/lib/integrations/core/api"
import { createRule, toRuleDTO } from "@/lib/integrations/core/rules"
import { getIntegrationStore } from "@/lib/integrations/core/store"

/**
 * /api/integrations/rules (M8 A3). Integration rules, admins only,
 * workspace scope. POST upserts the singleton email rule. Caps → 409.
 */
export const GET = withAuthz("integrations:manage", async (_request, ctx) => {
  const store = await getIntegrationStore()

  return NextResponse.json({ rules: (await store.listRules(ctx.workspace.id)).map(toRuleDTO) })
})

export const POST = withAuthz("integrations:manage", async (request, ctx) => {
  const limited = limitFor(request, ctx, "integrationsWrite")

  if (limited) return limited

  const result = await createRule(await getIntegrationStore(), {
    workspaceId: ctx.workspace.id,
    userId: actorUserId(ctx),
    isUserPrincipal: ctx.principal === "user",
    actor: auditActor(ctx),
    body: await readJsonBody(request),
  })

  if (!result.ok) {
    const { status, code, ok: _ok, ...extra } = result

    void _ok
    return apiError(code, status, extra)
  }

  return NextResponse.json({ rule: result.rule }, { status: 201 })
})
