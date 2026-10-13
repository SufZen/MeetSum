import { NextResponse } from "next/server"

import { auditActor } from "@/app/api/_lib/meeting-access"
import { createThreadStore } from "@/lib/ask/thread-store"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { userRequired } from "@/lib/comments/route-context"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const threadNotFound = () => NextResponse.json({ error: "not_found" }, { status: 404 })

/**
 * GET / PATCH / DELETE /api/ask/threads/:id — one of the caller's own
 * threads (docs/parity/m6.md, C8). User principals only. Another user's
 * thread (admins included) is a 404. PATCH `{title?, archived?}`; DELETE is
 * a soft delete, audited `ask.thread.deleted` with ids only.
 */
export const GET = withAuthz<{ id: string }>("meeting:read", async (_request, ctx, { params }) => {
  const store = createThreadStore(ctx)

  if (!store) return userRequired()

  const { id } = await params
  const result = await store.getThread(id)

  return result ? NextResponse.json(result) : threadNotFound()
})

export const PATCH = withAuthz<{ id: string }>("meeting:read", async (request, ctx, { params }) => {
  const store = createThreadStore(ctx)

  if (!store) return userRequired()

  const { id } = await params
  const patch = (await request.json().catch(() => ({}))) as { title?: unknown; archived?: unknown }
  const hasTitle = patch.title !== undefined
  const hasArchived = patch.archived !== undefined

  if (!hasTitle && !hasArchived) return NextResponse.json({ error: "title or archived is required" }, { status: 400 })
  if (hasTitle && patch.title !== null && typeof patch.title !== "string") {
    return NextResponse.json({ error: "title must be a string or null" }, { status: 400 })
  }
  if (hasArchived && typeof patch.archived !== "boolean") {
    return NextResponse.json({ error: "archived must be a boolean" }, { status: 400 })
  }

  let thread = (await store.getThread(id))?.thread ?? null

  if (thread && hasTitle) thread = await store.renameThread(id, (patch.title as string | null) || null)
  if (thread && hasArchived) thread = await store.archiveThread(id, patch.archived as boolean)

  return thread ? NextResponse.json({ thread }) : threadNotFound()
})

export const DELETE = withAuthz<{ id: string }>("meeting:read", async (_request, ctx, { params }) => {
  const store = createThreadStore(ctx)

  if (!store) return userRequired()

  const { id } = await params

  if (!(await store.softDeleteThread(id))) return threadNotFound()

  await recordAuditLog({ ...auditActor(ctx), action: "ask.thread.deleted", targetType: "ask_thread", targetId: id })
  return NextResponse.json({ deleted: true })
})
