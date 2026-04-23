import { NextResponse } from "next/server"

import { jsonError, requireApiKey } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"
import { parseRequiredString } from "@/lib/meetings/validation"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = requireApiKey(request)

  if (unauthorized) {
    return unauthorized
  }

  const { id } = await params
  let question

  try {
    question = parseRequiredString(await request.json(), "question")
    return NextResponse.json({
      answer: await meetingRepository.askMeetingMemory(id, question),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return jsonError(message, message.endsWith("required") ? 400 : 404)
  }
}
