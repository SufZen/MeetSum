/**
 * M9 follow-up (review "Share verify", final design after two security
 * reviews: neither brute force nor lockout):
 * - a per-token failure throttle across IPs: after 10 failures, attempts are
 *   spaced 2 s, doubling to a 30 s cap (~2,880 guesses a day); never a lock;
 *   a success resets it; at 50 failures the meeting owner is notified once;
 * - the per-IP-per-token limit (10/min) still applies;
 * - a valid share-access cookie bypasses verification;
 * - scrypt runs under a process-wide semaphore (one token holds at most 2
 *   slots) with a short queue timeout.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const notify = vi.hoisted(() => ({ shareAttempts: vi.fn(async (input: unknown) => void input) }))

vi.mock("@/lib/notifications/notify", () => ({ notifyShareAttempts: notify.shareAttempts }))

import { POST } from "@/app/api/share/[token]/verify/route"
import { getSystemMeetingRepository } from "@/lib/meetings/store"
import { resetRateLimitsForTesting } from "@/lib/rate-limit"
import { SHARE_ACCESS_COOKIE, createShareAccessCookie } from "@/lib/sharing/share-access"
import { ShareVerifyBusyError, createConcurrencyLimiter } from "@/lib/sharing/share-password"
import {
  SHARE_VERIFY_THROTTLE,
  createShareVerifyThrottle,
  getShareVerifyThrottle,
  shareVerifySpacingMs,
} from "@/lib/sharing/share-verify-throttle"
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"

const SECRET = "share-verify-limits-secret"
const PASSWORD = "correct-horse-battery"
const KEYS = ["MEETSUM_SESSION_SECRET", "MEETSUM_RATE_LIMIT", "MEETSUM_TRUSTED_PROXY_HOPS"] as const
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

describe("share verify throttle (unit, fake clock)", () => {
  it("spaces attempts 2 s → 30 s after 10 failures", () => {
    expect([0, 9, 10, 11, 12, 13, 14, 40].map((failures) => shareVerifySpacingMs(failures))).toEqual([
      0, 0, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ])
  })

  it("holds brute force from 100 IPs to the spacing schedule (~2,880 guesses a day)", () => {
    let clock = 0
    const throttle = createShareVerifyThrottle(() => clock)
    const allowedAt: number[] = []

    // 100 IPs, each trying every 10 s (one attempt every 100 ms overall), for a day.
    for (clock = 0; clock < 86_400_000; clock += 100) {
      if (throttle.begin("tok").allowed) {
        allowedAt.push(clock)
        throttle.fail("tok")
      }
    }

    for (let index = SHARE_VERIFY_THROTTLE.freeFailures + 1; index < allowedAt.length; index++) {
      expect(allowedAt[index]! - allowedAt[index - 1]!).toBeGreaterThanOrEqual(2_000)
    }
    expect(allowedAt.slice(0, SHARE_VERIFY_THROTTLE.freeFailures).every((at) => at < 1_000)).toBe(true)
    expect(allowedAt.length).toBeLessThanOrEqual(2_880 + 20)
    expect(allowedAt.length).toBeGreaterThan(2_000)
  })

  it("never locks: the rightful user gets in within the 30 s cap, and success resets the counter", () => {
    let clock = 0
    const throttle = createShareVerifyThrottle(() => clock)

    for (let index = 0; index < 40; index++) {
      while (!throttle.begin("tok").allowed) clock += 1_000
      throttle.fail("tok")
    }

    const blocked = throttle.begin("tok")

    expect(blocked.allowed).toBe(false)
    expect(blocked.allowed ? 0 : blocked.retryAfterMs).toBeLessThanOrEqual(SHARE_VERIFY_THROTTLE.maxSpacingMs)
    clock += SHARE_VERIFY_THROTTLE.maxSpacingMs
    expect(throttle.begin("tok").allowed).toBe(true)
    throttle.succeed("tok")
    expect(throttle.begin("tok").allowed).toBe(true)
    throttle.fail("tok")
    expect(throttle.begin("tok").allowed).toBe(true)
  })

  it("reports the owner notification once when failures reach 50 in the window", () => {
    let clock = 0
    const throttle = createShareVerifyThrottle(() => clock)
    const notices: number[] = []

    for (let index = 0; index < 80; index++) {
      clock += 31_000
      throttle.begin("tok")
      if (throttle.fail("tok").notifyOwner) notices.push(index + 1)
    }

    expect(notices).toEqual([50])
  })
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

  return { meeting, share: await repository.createMeetingShare({ meetingId: meeting.id, password: PASSWORD }) }
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

describe("POST /api/share/:token/verify limits", () => {
  let now = Date.parse("2026-10-13T12:00:00Z")
  const advance = (ms: number) => {
    now += ms
    vi.setSystemTime(now)
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(now)
    resetRateLimitsForTesting()
    getShareVerifyThrottle().reset()
    notify.shareAttempts.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("after 10 failures from distinct IPs an early attempt waits (429 + Retry-After), then gets in; success resets", async () => {
    const { share } = await protectedShare()

    for (let index = 0; index < 10; index++) expect((await attempt(share.token, `203.0.113.${index + 1}`)).status).toBe(403)

    const early = await attempt(share.token, "198.51.100.7", PASSWORD)

    expect(early.status).toBe(429)
    expect(Number(early.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(Number(early.headers.get("retry-after"))).toBeLessThanOrEqual(2)

    advance(2_000)
    const correct = await attempt(share.token, "198.51.100.7", PASSWORD)

    expect(correct.status).toBe(200)
    expect(await correct.json()).toMatchObject({ valid: true })
    // The counter was reset: the next attempt is not spaced.
    expect((await attempt(share.token, "198.51.100.8")).status).toBe(403)
  }, 30_000)

  it("still applies the per-IP limit", async () => {
    const { share } = await protectedShare()
    const statuses: number[] = []

    for (let index = 0; index < 11; index++) {
      statuses.push((await attempt(share.token, "192.0.2.10")).status)
      advance(3_000)
    }

    expect(statuses.slice(0, 10).every((status) => status === 403)).toBe(true)
    expect(statuses[10]).toBe(429)
  }, 30_000)

  it("notifies the meeting owner once when a link crosses 50 failures, with no password data", async () => {
    const { meeting, share } = await protectedShare()

    for (let index = 0; index < 55; index++) {
      expect((await attempt(share.token, `203.0.113.${index + 1}`)).status, `attempt ${index + 1}`).toBe(403)
      advance(SHARE_VERIFY_THROTTLE.maxSpacingMs + 1_000)
    }

    expect(notify.shareAttempts).toHaveBeenCalledTimes(1)
    expect(notify.shareAttempts).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: meeting.id, shareId: share.id, failures: 50 })
    )
    expect(JSON.stringify(notify.shareAttempts.mock.calls)).not.toMatch(/wrong-password|correct-horse|scrypt/)
  }, 60_000)

  it("a valid access cookie bypasses verification, even while the token is throttled", async () => {
    const { share } = await protectedShare()

    for (let index = 0; index < 10; index++) await attempt(share.token, `203.0.113.${index + 1}`)
    expect((await attempt(share.token, "203.0.113.99")).status).toBe(429)

    const cookie = createShareAccessCookie({ token: share.token, passwordHash: share.passwordHash!, secret: SECRET })
    const bypass = await attempt(share.token, "203.0.113.100", "", `${SHARE_ACCESS_COOKIE}=${cookie.value}`)

    expect(bypass.status).toBe(200)
    expect(await bypass.json()).toMatchObject({ valid: true })
  }, 30_000)

  it("a flood on one link does not starve another share", async () => {
    const [flooded, other] = await Promise.all([protectedShare(), protectedShare()])
    const flood = Array.from({ length: 30 }, (_, index) => attempt(flooded.share.token, `203.0.113.${index + 101}`))
    const response = await attempt(other.share.token, "198.51.100.9", PASSWORD)

    expect(response.status).toBe(200)
    await Promise.all(flood)
  }, 60_000)
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
      void limiter
        .run(async () => {
          active += 1
          peak = Math.max(peak, active)
          active -= 1
        })
        .catch(() => undefined)
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

describe("share_attempts notification", () => {
  it("goes to the meeting owner once per link per day, with counts only", async () => {
    const { createCollabMemoryDb } = await import("@/lib/clips/db")
    const { produceShareAttempts } = await import("@/lib/notifications/producers")
    const db = createCollabMemoryDb()
    const backend = { kind: "memory" as const, db }
    const input = { workspaceId: "ws_1", meetingId: "m_1", ownerUserId: "usr_owner", shareId: "share_1", failures: 50 }

    await produceShareAttempts(input, { backend })
    await produceShareAttempts({ ...input, failures: 51 }, { backend })

    const rows = db.notifications as Array<{ userId: string; kind: string; payload: Record<string, unknown> }>

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userId: "usr_owner", kind: "share_attempts" })
    expect(Object.keys(rows[0]!.payload).sort()).toEqual(["failures", "meetingId", "shareId"])
  })
})
