import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { createDelegatedGoogleClient, getWorkspaceSubject } from "@/lib/google/auth"
import { GOOGLE_WORKSPACE_SCOPES } from "@/lib/google/workspace"

function meetArtifactSetupResponse(subject: string, message: string, status = 200) {
  return NextResponse.json(
    {
      subject,
      conferenceRecords: [],
      nextPageToken: null,
      setup: {
        artifactMode: "google-artifacts-first",
        liveCapture: "native-recording-transcript-smart-notes",
        authorized: false,
        requiredScope: GOOGLE_WORKSPACE_SCOPES.meet[0],
        message,
      },
    },
    { status }
  )
}

async function getMeetAccessToken(subject: string) {
  const auth = await createDelegatedGoogleClient(subject, GOOGLE_WORKSPACE_SCOPES.meet)
  const tokenResponse = await auth.getAccessToken()
  const token =
    typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token

  if (!token) throw new Error("Unable to get Google Meet access token")

  return token
}

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const searchParams = new URL(request.url).searchParams
  const subject = searchParams.get("subject") ?? getWorkspaceSubject()
  const pageSize = Math.max(1, Math.min(Number(searchParams.get("limit") ?? 20), 50))

  try {
    const token = await getMeetAccessToken(subject)
    const response = await fetch(
      `https://meet.googleapis.com/v2/conferenceRecords?pageSize=${pageSize}`,
      { headers: { authorization: `Bearer ${token}` } }
    )
    const body = await response.json()

    if (!response.ok) {
      const message = body.error?.message ?? "Unable to list Google Meet artifacts"

      if (response.status === 401 || response.status === 403) {
        return meetArtifactSetupResponse(subject, message)
      }

      return jsonError(message, response.status)
    }

    return NextResponse.json({
      subject,
      conferenceRecords: body.conferenceRecords ?? [],
      nextPageToken: body.nextPageToken,
      setup: {
        artifactMode: "google-artifacts-first",
        liveCapture: "native-recording-transcript-smart-notes",
        authorized: true,
      },
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to list Google Meet artifacts"

    if (
      message.toLowerCase().includes("unauthorized") ||
      message.toLowerCase().includes("not authorized") ||
      message.toLowerCase().includes("scope")
    ) {
      return meetArtifactSetupResponse(subject, message)
    }

    return jsonError(
      message,
      500
    )
  }
}
