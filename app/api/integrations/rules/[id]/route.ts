import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { actorUserId, apiError, auditActor, limitFor, readJsonBody } from "@/lib/integrations/core/api"
import { deleteRule, updateRule } from "@/lib/integrations/core/rules"
import { getIntegrationStore } from "@/lib/integrations/core/store"

/**
 * /api/integrations/rules/[id] (M8 A3). Another workspace's rule id is 404.
 * Editing another admin's rule resets `includePrivate` and stamps the editor.
 */
export const PATCH = withAuthz<{ id: string }>("integrations:manage", async (request, ctx, route) => {
  const limited = limitFor(request, ctx, "integrationsWrite")

  if (limited) return limited

  const { id } = await route.params
  const result = await updateRule(await getIntegrationStore(), {
    workspaceId: ctx.workspace.id,
    ruleId: id,
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

  return NextResponse.json({ rule: result.rule })
})

export const DELETE = withAuthz<{ id: string }>("integrations:manage", async (request, ctx, route) => {
  const limited = limitFor(request, ctx, "integrationsWrite")

  if (limited) return limited

  const { id } = await route.params
  const deleted = await deleteRule(await getIntegrationStore(), { workspaceId: ctx.workspace.id, ruleId: id, actor: auditActor(ctx) })

  return deleted ? new Response(null, { status: 204 }) : apiError("not_found", 404)
})
