import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"
import { buildNotionBlocks, buildNotionProperties } from "@/lib/integrations/notion"
import { recordAuditLog } from "@/lib/audit"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * POST /api/meetings/:id/export/notion — Export meeting to Notion.
 * Body: { databaseId: string, token?: string }
 *
 * Uses Notion integration token from body or NOTION_TOKEN env var.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.exports)

  if (rateLimit.blocked) return rateLimit.blocked

  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const meeting = await meetingRepository.getMeeting(id)

  if (!meeting) return jsonError("Meeting not found", 404)

  const body = (await request.json().catch(() => ({}))) as {
    databaseId?: unknown
    token?: unknown
  }

  const databaseId =
    typeof body.databaseId === "string" ? body.databaseId.trim() : ""
  const token =
    typeof body.token === "string"
      ? body.token.trim()
      : process.env.NOTION_TOKEN ?? ""

  if (!databaseId) {
    return jsonError("databaseId is required", 400)
  }

  if (!token) {
    return jsonError(
      "Notion token required. Set NOTION_TOKEN env var or pass 'token' in body.",
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
        (error as { message?: string }).message ?? `Notion API error: ${notionRes.status}`

      await recordAuditLog({
        action: "meeting.export.notion",
        targetType: "meeting",
        targetId: id,
        metadata: { status: "failed", error: message },
      })

      return jsonError(message, notionRes.status >= 400 && notionRes.status < 500 ? 400 : 502)
    }

    const page = (await notionRes.json()) as { id: string; url: string }

    await recordAuditLog({
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
