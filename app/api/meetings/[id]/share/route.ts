import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"
import { getAppSettings } from "@/lib/settings/app-settings"

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
    const settings = await getAppSettings()

    if (!settings.publicSharingEnabled) {
      return jsonError("Public sharing is disabled in Settings", 403)
    }

    const defaultSections = [
      "summary",
      "decisions",
      settings.shareActionsByDefault ? "action_items" : undefined,
      settings.shareTranscriptByDefault ? "transcript" : undefined,
      "participants",
    ].filter((section): section is string => Boolean(section))
    const share = await meetingRepository.createMeetingShare({
      meetingId: id,
      includedSections: Array.isArray(body.includedSections)
        ? body.includedSections.map(String)
        : defaultSections,
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
    const settings = await getAppSettings()

    if (!settings.publicSharingEnabled && body.revoked !== true) {
      return jsonError("Public sharing is disabled in Settings", 403)
    }

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
