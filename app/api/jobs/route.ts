import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"
import type { JobStatus } from "@/lib/meetings/repository"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const url = new URL(request.url)
  const meetingId = url.searchParams.get("meetingId") ?? undefined
  const status = url.searchParams.get("status") as JobStatus | null

  return NextResponse.json({
    jobs: await meetingRepository.listJobs({
      meetingId,
      status: status ?? undefined,
    }),
  })
}
