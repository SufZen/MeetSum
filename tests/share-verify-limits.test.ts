/**
 * M9 follow-up (review "Share verify"): a per-token password-attempt limit
 * across IPs, and a small concurrency cap on scrypt verifications.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { POST } from "@/app/api/share/[token]/verify/route"
import { getSystemMeetingRepository } from "@/lib/meetings/store"
import { resetRateLimitsForTesting } from "@/lib/rate-limit"
import { ShareVerifyBusyError, createConcurrencyLimiter } from "@/lib/sharing/share-password"
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"

const previous = { secret: process.env.MEETSUM_SESSION_SECRET, rateLimit: process.env.MEETSUM_RATE_LIMIT, hops: process.env.MEETSUM_TRUSTED_PROXY_HOPS }

beforeAll(() => {
  process.env.MEETSUM_SESSION_SECRET = "share-verify-limits-secret"
  delete process.env.MEETSUM_RATE_LIMIT
  process.env.MEETSUM_TRUSTED_PROXY_HOPS = "1"
})

afterAll(() => {
  for (const [key, value] of [
    ["MEETSUM_SESSION_SECRET", previous.secret],
    ["MEETSUM_RATE_LIMIT", previous.rateLimit],
    ["MEETSUM_TRUSTED_PROXY_HOPS", previous.hops],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

beforeEach(() => resetRateLimitsForTesting())

function attempt(token: string, ip: string) {
  return POST(
    new Request(`http://localhost/api/share/${token}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ password: "wrong-password" }),
    }),
    { params: Promise.resolve({ token }) }
  )
}

describe("share verify limits", () => {
  it("limits password attempts per token even when every attempt comes from a new IP", async () => {
    const repository = getSystemMeetingRepository(DEFAULT_WORKSPACE_ID)
    const meeting = await repository.createMeeting({
      title: "Limited share",
      startedAt: new Date().toISOString(),
      source: "upload",
      language: "he",
      participants: [],
    })
    const share = await repository.createMeetingShare({ meetingId: meeting.id, password: "correct-horse" })
    const statuses: number[] = []

    for (let index = 0; index < 32; index++) {
      statuses.push((await attempt(share.token, `203.0.113.${index + 1}`)).status)
    }

    expect(statuses.slice(0, 30).every((status) => status === 403)).toBe(true)
    expect(statuses.slice(30)).toEqual([429, 429])
  }, 30_000)

  it("runs at most `max` verifications at once and rejects past the queue", async () => {
    const limiter = createConcurrencyLimiter(2, 2)
    let active = 0
    let peak = 0
    const gates: Array<() => void> = []
    const task = () =>
      limiter.run(async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => gates.push(resolve))
        active -= 1
        return true
      })
    const running = [task(), task(), task(), task()]

    await Promise.resolve()
    expect(limiter.stats()).toEqual({ running: 2, queued: 2 })
    await expect(task()).rejects.toBeInstanceOf(ShareVerifyBusyError)

    while (gates.length || limiter.stats().running) {
      gates.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await expect(Promise.all(running)).resolves.toEqual([true, true, true, true])
    expect(peak).toBe(2)
  })
})
