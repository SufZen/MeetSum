import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const rooms = await meetingRepository.listRooms()

  return NextResponse.json({ rooms })
}
