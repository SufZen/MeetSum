import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { buildMeetingMemoryAnswer } from "@/lib/memory"
import { meetingRepository } from "@/lib/meetings/store"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as { question?: unknown }
  const question = typeof body.question === "string" ? body.question.trim() : ""

  if (!question) return jsonError("Question is required", 400)

  const rooms = await meetingRepository.listRooms()
  const room = rooms.find((item) => item.id === id)

  if (!room) return jsonError("Room not found", 404)

  const meetings = await meetingRepository.listMeetingsByContext(id)

  return NextResponse.json(buildMeetingMemoryAnswer(question, meetings))
}
