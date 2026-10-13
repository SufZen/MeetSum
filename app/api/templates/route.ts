import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { listTemplateCatalog } from "@/lib/ai/templates/catalog"
import {
  customTemplateKey,
  parseTemplateInput,
  saveCustomTemplate,
  TemplateKeyConflictError,
} from "@/lib/ai/templates/store"

/** GET /api/templates (M5 D6): built-ins plus workspace templates. */
export const GET = withAuthz("workspace:read", async (request, ctx) => {
  const includeArchived = new URL(request.url).searchParams.get("includeArchived") === "1"

  return NextResponse.json(await listTemplateCatalog(ctx.workspace.id, { includeArchived }))
})

/** POST /api/templates: creates a workspace template (admins). */
export const POST = withAuthz("settings:write", async (request, ctx) => {
  const body = (await request.json().catch(() => undefined)) as unknown
  const parsed = parseTemplateInput(body)

  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid template", fieldErrors: parsed.errors }, { status: 400 })
  }

  try {
    const template = await saveCustomTemplate(ctx.workspace.id, parsed.input, {
      userId: ctx.principal === "user" ? ctx.user?.id : undefined,
    })

    await recordAuditLog({
      action: "template.created",
      ...ctx.audit,
      targetType: "summary_template",
      targetId: template.id,
      metadata: { key: customTemplateKey(template.key), sections: template.sections.length },
    })

    return NextResponse.json({ template }, { status: 201 })
  } catch (error) {
    if (error instanceof TemplateKeyConflictError) {
      return NextResponse.json({ error: "template_key_exists" }, { status: 409 })
    }

    return jsonError(error instanceof Error ? error.message : "Unable to save template", 500)
  }
})
