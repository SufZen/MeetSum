import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { createDelegatedGoogleClient, getWorkspaceSubject } from "@/lib/google/auth"
import { GOOGLE_WORKSPACE_SCOPES } from "@/lib/google/workspace"
import { createPlatformEvent } from "@/lib/platform/events"

async function getMeetAccessToken(subject: string) {
  const auth = await createDelegatedGoogleClient(subject, GOOGLE_WORKSPACE_SCOPES.meet)
  const tokenResponse = await auth.getAccessToken()
  const token =
    typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token

  if (!token) throw new Error("Unable to get Google Meet access token")

  return token
}

export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const body = (await request.json().catch(() => ({}))) as { subject?: string }
  const subject = body.subject ?? getWorkspaceSubject()

  try {
    const token = await getMeetAccessToken(subject)
    const response = await fetch(
      "https://meet.googleapis.com/v2/conferenceRecords?pageSize=10",
      { headers: { authorization: `Bearer ${token}` } }
    )
    const body = await response.json()

    if (!response.ok) {
      return jsonError(
        body.error?.message ?? "Unable to sync Google Meet artifacts",
        response.status
      )
    }

    const conferenceRecords = body.conferenceRecords ?? []

    return NextResponse.json({
      subject,
      status: "completed",
      mode: "google-artifacts-first",
      discovered: conferenceRecords.length,
      nextPageToken: body.nextPageToken ?? null,
      message:
        conferenceRecords.length > 0
          ? "Meet artifact access is working. Artifact import/linking will use these records as the source of truth."
          : "Meet artifact access is working, but no conference records were returned yet.",
      event: createPlatformEvent("google.drive.recording_found", {
        subject,
        source: "meet-artifacts",
        discovered: conferenceRecords.length,
      }),
    })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to sync Meet artifacts",
      500
    )
  }
}
