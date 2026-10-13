/**
 * M9 follow-up (review "Share verify", reworked after the security review):
 * - the per-IP-per-token limit (10/min) still applies;
 * - the per-token layer never locks a link: many failures from distinct IPs
 *   do not stop a correct password from a new IP; above a high ceiling it
 *   only sheds load (429 + Retry-After), and a valid access cookie bypasses
 *   verification entirely;
 * - scrypt runs under a process-wide semaphore with a per-token share and a
 *   short queue timeout (busy → 503).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { POST } from "@/app/api/share/[token]/verify/route"
import { getSystemMeetingRepository } from "@/lib/meetings/store"
import { resetRateLimitsForTesting } from "@/lib/rate-limit"
import { SHARE_ACCESS_COOKIE, createShareAccessCookie } from "@/lib/sharing/share-access"
import { ShareVerifyBusyError, createConcurrencyLimiter } from "@/lib/sharing/share-password"
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"

const SECRET = "share-verify-limits-secret"
const KEYS = ["MEETSUM_SESSION_SECRET", "MEETSUM_RATE_LIMIT", "MEETSUM_TRUSTED_PROXY_HOPS", "MEETSUM_SHARE_VERIFY_TOKEN_CEILING"] as const
const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))

beforeAll(() => {
  process.env.MEETSUM_SESSION_SECRET = SECRET
  delete process.env.MEETSUM_RATE_LIMIT
  process.env.MEETSUM_TRUSTED_PROXY_HOPS = "1"
})

afterAll(() => {
  for (const key of KEYS) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
})

beforeEach(() => resetRateLimitsForTesting())
afterEach(() => {
  delete process.env.MEETSUM_SHARE_VERIFY_TOKEN_CEILING
})

async function protectedShare() {
  const repository = getSystemMeetingRepository(DEFAULT_WORKSPACE_ID)
  const meeting = await repository.createMeeting({
    title: "Limited share",
    startedAt: new Date().toISOString(),
    source: "upload",
    language: "he",
    participants: [],
  })

  return repository.createMeetingShare({ meetingId: meeting.id, password: "correct-horse" })
}

function attempt(token: string, ip: string, password = "wrong-password", cookie?: string) {
  return POST(
    new Request(`http://localhost/api/share/${token}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": ip,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ password }),
    }),
    { params: Promise.resolve({ token }) }
  )
}

describe("share verify limits", () => {
  it("never locks the link: after many failures from distinct IPs a correct password from a new IP gets in", async () => {
    const share = await protectedShare()
    const failures = await Promise.all(
      Array.from({ length: 60 }, (_, index) => attempt(share.token, `203.0.113.${index + 1}`).then((response) => response.status))
    )

    // A simultaneous burst past the token's short queue is shed (503), never locked.
    expect(failures.every((status) => status === 403 || status === 503)).toBe(true)
    expect(failures.filter((status) => status === 403).length).toBeGreaterThanOrEqual(18)

    const started = Date.now()
    const correct = await attempt(share.token, "198.51.100.7", "correct-horse")

    expect(correct.status).toBe(200)
    expect(await correct.json()).toMatchObject({ valid: true })
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 60_000)

  it("a flood on one link does not starve another share", async () => {
    const [flooded, other] = await Promise.all([protectedShare(), protectedShare()])
    const flood = Array.from({ length: 30 }, (_, index) => attempt(flooded.token, `203.0.113.${index + 101}`))
    const started = Date.now()
    const response = await attempt(other.token, "198.51.100.8", "correct-horse")

    expect(response.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(5_000)
    await Promise.all(flood)
  }, 60_000)

  it("still applies the per-IP limit", async () => {
    const share = await protectedShare()
    const statuses: number[] = []

    for (let index = 0; index < 11; index++) statuses.push((await attempt(share.token, "192.0.2.10")).status)

    expect(statuses.slice(0, 10).every((status) => status === 403)).toBe(true)
    expect(statuses[10]).toBe(429)
  }, 30_000)

  it("above the token ceiling only sheds load (429 + Retry-After); a valid access cookie bypasses verify", async () => {
    process.env.MEETSUM_SHARE_VERIFY_TOKEN_CEILING = "3"
    const share = await protectedShare()

    for (let index = 0; index < 3; index++) expect((await attempt(share.token, `203.0.113.${index + 1}`)).status).toBe(403)

    const shed = await attempt(share.token, "203.0.113.99", "correct-horse")

    expect(shed.status).toBe(429)
    expect(Number(shed.headers.get("retry-after"))).toBeGreaterThan(0)

    const cookie = createShareAccessCookie({ token: share.token, passwordHash: share.passwordHash!, secret: SECRET })
    const bypass = await attempt(share.token, "203.0.113.100", "", `${SHARE_ACCESS_COOKIE}=${cookie.value}`)

    expect(bypass.status).toBe(200)
    expect(await bypass.json()).toMatchObject({ valid: true })
  }, 30_000)
})

describe("scrypt semaphore", () => {
  it("runs at most `max` at once, hands slots to waiters in order, and rejects past the queue", async () => {
    const limiter = createConcurrencyLimiter(2, 2, 1_000)
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
      // A fresh caller arriving mid-handoff must not exceed the cap.
      void limiter.run(async () => {
        active += 1
        peak = Math.max(peak, active)
        active -= 1
      }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await expect(Promise.all(running)).resolves.toEqual([true, true, true, true])
    expect(peak).toBe(2)
  })

  it("times a waiter out with ShareVerifyBusyError instead of queueing forever", async () => {
    const limiter = createConcurrencyLimiter(1, 4, 20)
    let release = () => {}
    const holder = limiter.run(() => new Promise<void>((resolve) => (release = resolve)))

    await expect(limiter.run(async () => "late")).rejects.toBeInstanceOf(ShareVerifyBusyError)
    expect(limiter.stats()).toEqual({ running: 1, queued: 0 })
    release()
    await holder
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok")
  })
})
