/**
 * M9 C2 workspace analytics on Postgres (PGlite, fixture in
 * tests/helpers/pglite-m9.ts) and the pure fold (docs/parity/m9.md):
 * totals, coverage, zone bucketing, the member breakdown hidden for members,
 * small-member folding, and security check 1: an admin's numbers exclude
 * another member's private meeting (2 h of talk time, 5 action items), W2
 * never leaks into W1, a viewer sees only shared meetings.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { computeAnalyticsOverview } from "@/lib/analytics/dashboard/compute"
import { getAnalyticsOverview, type AnalyticsRequester } from "@/lib/analytics/dashboard/service"
import type { AnalyticsOverview, AnalyticsQuery } from "@/lib/analytics/dashboard/types"

import { USERS, W1, W2, createM9Database, seedM9Analytics, seedM9Workspaces, type PgLike } from "./helpers/pglite-m9"

const OCTOBER: AnalyticsQuery = {
  from: "2026-09-30T21:00:00.000Z",
  to: "2026-10-31T22:00:00.000Z",
  interval: "month",
  scope: "workspace",
  timeZone: "Asia/Jerusalem",
}

let db: PgLike | undefined

beforeAll(async () => {
  db = await createM9Database()
  if (!db) return
  await seedM9Workspaces(db)
  await seedM9Analytics(db)
}, 120_000)

afterAll(async () => {
  await db?.close()
})

function requester(user: keyof typeof USERS, role: AnalyticsRequester["role"], workspaceId = W1): AnalyticsRequester {
  return { workspaceId, userId: USERS[user].id, email: USERS[user].email, role }
}

async function overview(who: AnalyticsRequester, query: Partial<AnalyticsQuery> = {}): Promise<AnalyticsOverview> {
  const result = await getAnalyticsOverview(who, { ...OCTOBER, ...query }, { db: db! })

  if (!result.ok) throw new Error(result.error)

  return result.overview
}

describe("analytics on Postgres", () => {
  it("an admin's numbers exclude the member's private meeting everywhere", async (context) => {
    if (!db) return context.skip("PGlite did not load")

    const admin = await overview(requester("admin", "admin"))

    expect(admin.totals).toEqual({ meetings: 4, durationMs: 8_100_000, avgDurationMs: 2_025_000 })
    expect(admin.series).toEqual([{ bucket: "2026-10-01", meetings: 4, durationMs: 8_100_000 }])
    expect(admin.talkTime.coverage).toEqual({ withAnalytics: 3, total: 4 })
    expect(admin.talkTime.unconfirmedMs).toBe(600_000)
    expect(admin.talkTime.othersMs).toBe(300_000) // the member spoke in 1 visible meeting: folded
    expect(admin.talkTime.byMember?.map((row) => [row.userId, row.ms])).toEqual([
      ["usr_admin", 2_700_000],
      ["usr_owner", 2_700_000],
    ])
    expect(admin.talkTime.byMember?.[0]?.share).toBeCloseTo(2.7 / 6.3)
    expect(admin.topics.map((topic) => [topic.tag, topic.total])).toEqual([
      ["sales", 2],
      ["hr", 1],
    ])
    expect(admin.actionItems).toMatchObject({ created: 3, completed: 1, overdue: 1, medianHoursToComplete: 24 })
    expect(admin.actionItems.completionRate).toBeCloseTo(1 / 3)
    expect(admin.me).toMatchObject({ meetings: 2, talkMs: 2_700_000, tasksOpen: 1, tasksDone: 0 })
    expect(admin.me.talkShare).toBeCloseTo(2.7 / 6.3)
    expect(JSON.stringify(admin)).not.toContain("secret")
  })

  it("the owner of the private meeting sees it; members get no breakdown", async (context) => {
    if (!db) return context.skip("PGlite did not load")

    const member = await overview(requester("member", "member"))

    expect(member.totals.meetings).toBe(5)
    expect(member.totals.durationMs).toBe(15_300_000)
    expect(member.talkTime.byMember).toBeUndefined()
    expect(member.talkTime.othersMs).toBe(5_400_000)
    expect(member.me.talkMs).toBe(7_500_000)
    expect(member.topics.map((topic) => topic.tag)).toContain("secret")
    expect(member.actionItems).toMatchObject({ created: 8, completed: 3, overdue: 2 })
    expect(member.me).toMatchObject({ meetings: 2, tasksOpen: 3, tasksDone: 2 })
  })

  it("a viewer and the W2 owner see only their own workspace's shared meetings", async (context) => {
    if (!db) return context.skip("PGlite did not load")

    const viewer = await overview(requester("viewer", "viewer"))
    const w2 = await overview(requester("w2", "owner", W2))

    expect(viewer.totals.meetings).toBe(4)
    expect(viewer.talkTime.byMember).toBeUndefined()
    expect(w2.totals).toEqual({ meetings: 1, durationMs: 2_700_000, avgDurationMs: 2_700_000 })
    expect(w2.topics.map((topic) => [topic.tag, topic.total])).toEqual([["sales", 1]])
    expect(w2.actionItems.created).toBe(1)
  })

  it("buckets in the requester's zone and fills empty buckets", async (context) => {
    if (!db) return context.skip("PGlite did not load")

    const days = await overview(requester("admin", "admin"), {
      from: "2026-10-11T21:00:00.000Z",
      to: "2026-10-14T21:00:00.000Z",
      interval: "day",
    })

    // m_a2 starts 2026-10-12T21:30Z = 00:30 on Oct 13 in Jerusalem.
    expect(days.series).toEqual([
      { bucket: "2026-10-12", meetings: 0, durationMs: 0 },
      { bucket: "2026-10-13", meetings: 1, durationMs: 1_800_000 },
      { bucket: "2026-10-14", meetings: 0, durationMs: 0 },
    ])

    const utc = await overview(requester("admin", "admin"), {
      from: "2026-10-12T00:00:00.000Z",
      to: "2026-10-14T00:00:00.000Z",
      interval: "day",
      timeZone: "UTC",
    })

    expect(utc.series.find((point) => point.meetings === 1)?.bucket).toBe("2026-10-12")
  })

  it("scope=me and roomId narrow the visible set; a foreign room is refused", async (context) => {
    if (!db) return context.skip("PGlite did not load")

    expect((await overview(requester("admin", "admin"), { scope: "me" })).totals.meetings).toBe(2)
    expect((await overview(requester("admin", "admin"), { roomId: "ctx_w1" })).totals.meetings).toBe(1)
    expect((await overview(requester("member", "member"), { roomId: "ctx_w1" })).totals.meetings).toBe(2)
    expect(await getAnalyticsOverview(requester("admin", "admin"), { ...OCTOBER, roomId: "ctx_w2" }, { db: db! })).toEqual({
      ok: false,
      error: "room_not_found",
    })
  })
})

describe("computeAnalyticsOverview", () => {
  const rows = {
    series: [
      { bucket: "2026-10-01", meetings: 2, duration_ms: "3000" },
      { bucket: "2026-10-08", meetings: 0, duration_ms: 0 },
    ],
    coverage: [{ total: 2, with_analytics: 1, mine: 1 }],
    talk: [
      { user_id: "u_big", name: "Big", ms: 600, meetings: 3 },
      { user_id: "u_small", name: "Small", ms: 300, meetings: 2 },
      { user_id: null, name: null, ms: 100, meetings: 1 },
    ],
    topics: Array.from({ length: 10 }, (_, index) => ({ tag: `t${index}`, bucket: "2026-10-01", count: index + 1 })),
    actionSeries: [{ bucket: "2026-10-08", created: 4, completed: 1 }],
    actionSummary: [{ overdue: 1, median_hours: null, mine_open: 2, mine_done: 0 }],
  }

  it("folds members under the threshold into others and keeps the top 8 topics", () => {
    const result = computeAnalyticsOverview(
      { ...OCTOBER, interval: "week" },
      rows,
      { userId: "u_small", canSeeMembers: true }
    )

    expect(result.talkTime.byMember).toEqual([{ userId: "u_big", name: "Big", ms: 600, share: 0.6 }])
    expect(result.talkTime.othersMs).toBe(300)
    expect(result.talkTime.unconfirmedMs).toBe(100)
    expect(result.topics).toHaveLength(8)
    expect(result.topics[0]).toEqual({
      tag: "t9",
      total: 10,
      series: [
        { bucket: "2026-10-01", count: 10 },
        { bucket: "2026-10-08", count: 0 },
      ],
    })
    expect(result.actionItems.series).toEqual([
      { bucket: "2026-10-01", created: 0, completed: 0 },
      { bucket: "2026-10-08", created: 4, completed: 1 },
    ])
    expect(result.actionItems.medianHoursToComplete).toBeNull()
    expect(result.me).toEqual({ meetings: 1, talkMs: 300, talkShare: 0.3, tasksOpen: 2, tasksDone: 0 })
  })

  it("hides the breakdown for members and reports others without them", () => {
    const result = computeAnalyticsOverview(OCTOBER, rows, { userId: "u_small", canSeeMembers: false })

    expect(result.talkTime.byMember).toBeUndefined()
    expect(result.talkTime.othersMs).toBe(600)
  })
})
