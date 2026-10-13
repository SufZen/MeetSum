import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"

export const GET = withAuthz("workspace:read", async (_request, ctx) =>
  NextResponse.json({ contexts: await ctx.meetings.listContexts() })
)

export const POST = withAuthz("contexts:write", async (request, ctx) => {
  const { name, description } = (await request.json().catch(() => ({}))) as {
    name?: string
    description?: string
  }

  if (!name?.trim()) {
    return jsonError("name is required", 400)
  }

  const context = await ctx.meetings.createContext({
    name: name.trim(),
    description,
  })

  return NextResponse.json({ context }, { status: 201 })
})
