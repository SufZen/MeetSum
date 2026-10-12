import { NextResponse } from "next/server"

import {
  auditActor,
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { can, withAuthz } from "@/lib/auth/authz"
import {
  buildNotionBlocks,
  buildNotionProperties,
} from "@/lib/integrations/notion"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * POST /api/meetings/:id/export/notion — Export meeting to Notion.
 * Body: { databaseId: string, token: string }
 *
 * Writes meeting content to an external workspace, so it needs
 * `meeting:write` plus `integrations:manage` (role >= admin). The Notion
 * integration token must come from the request body: there is deliberately
 * no server-wide fallback token (it would let any tenant write into the
 * operator's Notion workspace).
 */
export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    if (!can(ctx.role, "integrations:manage")) {
      return NextResponse.json(
        { error: "Forbidden", permission: "integrations:manage" },
        { status: 403 }
      )
    }

    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.exports)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    const body = (await request.json().catch(() => ({}))) as {
      databaseId?: unknown
      token?: unknown
    }

    const databaseId =
      typeof body.databaseId === "string" ? body.databaseId.trim() : ""
    const token = typeof body.token === "string" ? body.token.trim() : ""

    if (!databaseId) {
      return jsonError("databaseId is required", 400)
    }

    if (!token) {
      return jsonError(
        "Notion token required. Pass the Notion integration 'token' in the body.",
        400
      )
    }

    try {
      const blocks = buildNotionBlocks(meeting)
      const properties = buildNotionProperties(meeting)

      // Create page in Notion
      const notionRes = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28",
        },
        body: JSON.stringify({
          parent: { database_id: databaseId },
          properties,
          children: blocks,
        }),
      })

      if (!notionRes.ok) {
        const error = await notionRes.json().catch(() => ({}))
        const message =
          (error as { message?: string }).message ??
          `Notion API error: ${notionRes.status}`

        await recordAuditLog({
          ...auditActor(ctx),
          action: "meeting.export.notion",
          targetType: "meeting",
          targetId: id,
          metadata: { status: "failed", error: message },
        })

        return jsonError(
          message,
          notionRes.status >= 400 && notionRes.status < 500 ? 400 : 502
        )
      }

      const page = (await notionRes.json()) as { id: string; url: string }

      await recordAuditLog({
        ...auditActor(ctx),
        action: "meeting.export.notion",
        targetType: "meeting",
        targetId: id,
        metadata: { notionPageId: page.id, notionUrl: page.url },
      })

      return NextResponse.json(
        {
          notionPageId: page.id,
          notionUrl: page.url,
          blocksCreated: blocks.length,
        },
        { status: 201, headers: rateLimit.headers }
      )
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Failed to export to Notion",
        500
      )
    }
  }
)
