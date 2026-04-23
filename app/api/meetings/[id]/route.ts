import { NextResponse } from "next/server"

import { meetingRepository } from "@/lib/meetings/store"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const meeting = meetingRepository.getMeeting(id)

  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 })
  }

  return NextResponse.json({ meeting })
}
