import { NextResponse } from "next/server"

import { jsonError, requireApiKey } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"

export async function GET(request: Request) {
  const unauthorized = requireApiKey(request)

  if (unauthorized) {
    return unauthorized
  }

  return NextResponse.json({ contexts: await meetingRepository.listContexts() })
}

export async function POST(request: Request) {
  const unauthorized = requireApiKey(request)

  if (unauthorized) {
    return unauthorized
  }

  const { name, description } = (await request.json()) as {
    name?: string
    description?: string
  }

  if (!name?.trim()) {
    return jsonError("name is required", 400)
  }

  const context = await meetingRepository.createContext({
    name: name.trim(),
    description,
  })

  return NextResponse.json({ context }, { status: 201 })
}
