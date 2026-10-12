import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { POST } from "@/app/api/share/[token]/verify/route"
import { getSystemMeetingRepository } from "@/lib/meetings/store"
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"
import {
  SHARE_ACCESS_COOKIE,
  verifyShareAccessCookie,
} from "@/lib/sharing/share-access"

const meetingRepository = getSystemMeetingRepository(DEFAULT_WORKSPACE_ID)

const SECRET = "share-verify-route-secret"
let previousSecret: string | undefined
let previousRateLimit: string | undefined

beforeAll(() => {
  previousSecret = process.env.MEETSUM_SESSION_SECRET
  previousRateLimit = process.env.MEETSUM_RATE_LIMIT
  process.env.MEETSUM_SESSION_SECRET = SECRET
  process.env.MEETSUM_RATE_LIMIT = "false"
})

afterAll(() => {
  if (previousSecret === undefined) delete process.env.MEETSUM_SESSION_SECRET
  else process.env.MEETSUM_SESSION_SECRET = previousSecret
  if (previousRateLimit === undefined) delete process.env.MEETSUM_RATE_LIMIT
  else process.env.MEETSUM_RATE_LIMIT = previousRateLimit
})

async function createProtectedShare() {
  const meeting = await meetingRepository.createMeeting({
    title: "Protected share",
    startedAt: new Date().toISOString(),
    source: "upload",
    language: "he",
    participants: [],
  })

  return meetingRepository.createMeetingShare({
    meetingId: meeting.id,
    password: "correct-horse",
  })
}

function formPost(token: string, password: string) {
  return POST(
    new Request(`http://localhost/api/share/${token}/verify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password }).toString(),
    }),
    { params: Promise.resolve({ token }) }
  )
}

describe("POST /api/share/:token/verify", () => {
  it("sets a signed httpOnly cookie and redirects without the password in the URL", async () => {
    const share = await createProtectedShare()
    const response = await formPost(share.token, "correct-horse")

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`/share/${share.token}`)

    const setCookie = response.headers.get("set-cookie") ?? ""

    expect(setCookie).toContain(`${SHARE_ACCESS_COOKIE}=`)
    expect(setCookie.toLowerCase()).toContain("httponly")
    expect(setCookie).toContain(`Path=/share/${share.token}`)
    expect(setCookie).not.toContain("correct-horse")

    const value = decodeURIComponent(
      setCookie.split(";")[0]!.slice(SHARE_ACCESS_COOKIE.length + 1)
    )

    expect(
      verifyShareAccessCookie(value, {
        token: share.token,
        passwordHash: share.passwordHash!,
        secret: SECRET,
      })
    ).toBe(true)
  })

  it("redirects back with an error code and no cookie on a wrong password", async () => {
    const share = await createProtectedShare()
    const response = await formPost(share.token, "wrong")

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(
      `/share/${share.token}?error=invalid`
    )
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("keeps the JSON contract for API clients", async () => {
    const share = await createProtectedShare()
    const response = await POST(
      new Request(`http://localhost/api/share/${share.token}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct-horse" }),
      }),
      { params: Promise.resolve({ token: share.token }) }
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ valid: true })
    expect(response.headers.get("set-cookie")).toContain(SHARE_ACCESS_COOKIE)
  })
})
