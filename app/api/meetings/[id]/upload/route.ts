import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { ingestDesktopCaptureForMeeting } from "@/lib/capture/desktop-upload"
import { createPlatformEvent } from "@/lib/platform/events"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  const { id } = await params
  let result: Awaited<ReturnType<typeof ingestDesktopCaptureForMeeting>>

  try {
    result = await ingestDesktopCaptureForMeeting({
      meetingId: id,
      formData: await request.formData(),
    })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Invalid upload payload",
      400
    )
  }

  return NextResponse.json(
    {
      asset: result.asset,
      job: result.job,
      transcriptSegments: result.transcriptSegments.length,
      captureMetadata: result.captureMetadata,
      event: createPlatformEvent("meeting.created", { meetingId: id }),
    },
    { status: 202 }
  )
}
