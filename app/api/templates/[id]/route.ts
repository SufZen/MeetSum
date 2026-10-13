import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import {
  archiveCustomTemplate,
  customTemplateKey,
  getCustomTemplate,
  parseTemplateInput,
  saveCustomTemplate,
  TemplateKeyConflictError,
  TemplateKeyImmutableError,
  TemplateNotFoundError,
} from "@/lib/ai/templates/store"

function templateNotFound() {
  return jsonError("Template not found", 404)
}

/** GET /api/templates/:id (M5 D6). */
export const GET = withAuthz<{ id: string }>("workspace:read", async (_request, ctx, { params }) => {
  const { id } = await params
  const template = await getCustomTemplate(ctx.workspace.id, id)

  return template ? NextResponse.json({ template }) : templateNotFound()
})

/** PATCH /api/templates/:id: replaces the editable fields (admins). */
export const PATCH = withAuthz<{ id: string }>("settings:write", async (request, ctx, { params }) => {
  const { id } = await params
  const existing = await getCustomTemplate(ctx.workspace.id, id)

  if (!existing) return templateNotFound()

  const body = (await request.json().catch(() => undefined)) as unknown

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("Template patch must be an object", 400)
  }

  const parsed = parseTemplateInput({ ...existing, ...(body as Record<string, unknown>) })

  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid template", fieldErrors: parsed.errors }, { status: 400 })
  }

  try {
    const template = await saveCustomTemplate(ctx.workspace.id, { ...parsed.input, id }, {
      userId: ctx.user?.id,
    })

    await recordAuditLog({
      action: "template.updated",
      ...ctx.audit,
      targetType: "summary_template",
      targetId: id,
      metadata: { key: customTemplateKey(template.key), fields: Object.keys(body as object) },
    })

    return NextResponse.json({ template })
  } catch (error) {
    if (error instanceof TemplateKeyConflictError) {
      return NextResponse.json({ error: "template_key_exists" }, { status: 409 })
    }
    if (error instanceof TemplateKeyImmutableError) {
      return NextResponse.json({ error: "template_key_immutable" }, { status: 409 })
    }
    if (error instanceof TemplateNotFoundError) return templateNotFound()

    return jsonError(error instanceof Error ? error.message : "Unable to save template", 500)
  }
})

/** DELETE /api/templates/:id: archives (admins); meetings keep their key. */
export const DELETE = withAuthz<{ id: string }>("settings:write", async (_request, ctx, { params }) => {
  const { id } = await params
  const template = await archiveCustomTemplate(ctx.workspace.id, id)

  if (!template) return templateNotFound()

  await recordAuditLog({
    action: "template.archived",
    ...ctx.audit,
    targetType: "summary_template",
    targetId: id,
    metadata: { key: customTemplateKey(template.key) },
  })

  return NextResponse.json({ template })
})
