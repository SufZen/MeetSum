import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"

function shareUrl(request: Request, token: string) {
  const url = new URL(request.url)

  return `${url.origin}/share/${token}`
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const body = await request.json().catch(() => ({}))

  try {
    const share = await meetingRepository.createMeetingShare({
      meetingId: id,
      includedSections: Array.isArray(body.includedSections)
        ? body.includedSections.map(String)
        : undefined,
    })

    return NextResponse.json({ share, url: shareUrl(request, share.token) })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to create share link",
      400
    )
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const body = await request.json().catch(() => ({}))

  try {
    const share = await meetingRepository.updateMeetingShare(id, {
      revoked: typeof body.revoked === "boolean" ? body.revoked : undefined,
      regenerate: body.regenerate === true,
      includedSections: Array.isArray(body.includedSections)
        ? body.includedSections.map(String)
        : undefined,
    })

    return NextResponse.json({ share, url: shareUrl(request, share.token) })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to update share link",
      400
    )
  }
}
