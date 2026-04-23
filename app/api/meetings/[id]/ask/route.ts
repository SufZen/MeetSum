import { NextResponse } from "next/server"

import { meetingRepository } from "@/lib/meetings/store"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { question } = (await request.json()) as { question?: string }

  if (!question) {
    return NextResponse.json({ error: "Question is required" }, { status: 400 })
  }

  try {
    return NextResponse.json({
      answer: meetingRepository.askMeetingMemory(id, question),
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 404 },
    )
  }
}
