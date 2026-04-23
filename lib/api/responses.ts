import { NextResponse } from "next/server"

import { isAuthorizedApiRequest } from "@/lib/auth/api-keys"

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}

export function requireApiKey(request: Request) {
  if (process.env.MEETSUM_REQUIRE_API_KEY !== "true") {
    return undefined
  }

  if (!isAuthorizedApiRequest(request)) {
    return jsonError("Unauthorized", 401)
  }

  return undefined
}
