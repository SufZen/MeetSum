/**
 * M9 C4 seed (docs/parity/m9.md): refuses non-local targets (security check
 * 9), writes the B4 password-hash format, and on PGlite produces the fixture
 * the e2e expects: the admin's dashboard excludes the member's private
 * meeting, the admin has one unread notification of every kind plus a stale
 * one whose title is blanked at read time, and W3 is fresh for onboarding.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { getAnalyticsOverview } from "@/lib/analytics/dashboard/service"
import { countUnreadNotifications, listNotifications } from "@/lib/notifications/store"
import { createPostgresMeetingRepository } from "@/lib/meetings/postgres-repository"
import { computeOnboardingRedirect } from "@/lib/onboarding/service"
import { createPostgresOnboardingProgressStore } from "@/lib/onboarding/progress"
import { NOTIFICATION_KINDS } from "@/lib/notifications/types"
import { assertLocalTarget, hashSharePasswordForSeed, seedM9E2E } from "@/scripts/m9-e2e-seed"

import { createM9Database, type PgLike } from "./helpers/pglite-m9"

describe("seed guards", () => {
  it("refuses non-local databases and base URLs", () => {
    const env = (extra: Record<string, string>) => extra as unknown as NodeJS.ProcessEnv

    expect(() => assertLocalTarget(env({}))).toThrow(/DATABASE_URL/)
    expect(() => assertLocalTarget(env({ DATABASE_URL: "postgres://u:p@db.example.com:5432/x" }))).toThrow(/localhost/)
    expect(() =>
      assertLocalTarget(env({ DATABASE_URL: "postgres://u:p@localhost:5432/x", E2E_BASE_URL: "https://meetsum.example.com" }))
    ).toThrow(/E2E_BASE_URL/)
    expect(() =>
      assertLocalTarget(env({ DATABASE_URL: "postgres://u:p@127.0.0.1:5432/x", E2E_BASE_URL: "http://localhost:3000" }))
    ).not.toThrow()
  })

  it("hashes the share password in the scrypt B4 format", () => {
    expect(hashSharePasswordForSeed("correct horse")).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/)
  })
})

let db: PgLike | undefined
let env: Record<string, string> = {}

beforeAll(async () => {
  db = await createM9Database()
  if (!db) return

  const lines = await seedM9E2E(db, { secret: "test-secret-0123456789abcdef0123456789", now: Date.parse("2026-10-13T12:00:00Z") })

  env = Object.fromEntries(lines.filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe("seeded fixture", () => {
  it("gives the admin a dashboard without the member's private meeting", async (context) => {
    if (!db) return context.skip("PGlite did not load")

    const query = {
      from: "2026-07-15T12:00:00.000Z",
      to: "2026-10-13T12:00:00.000Z",
      interval: "week" as const,
      scope: "workspace" as const,
      timeZone: "Asia/Jerusalem",
    }
    const admin = await getAnalyticsOverview(
      { workspaceId: env.E2E_M9_W1_WORKSPACE_ID!, userId: "e2e_m9_admin", email: "m9-admin@example.test", role: "admin" },
      query,
      { db }
    )
    const member = await getAnalyticsOverview(
      { workspaceId: env.E2E_M9_W1_WORKSPACE_ID!, userId: "e2e_m9_member", email: "m9-member@example.test", role: "member" },
      query,
      { db }
    )

    if (!admin.ok || !member.ok) throw new Error("overview failed")
    expect(admin.overview.totals.meetings).toBe(Number(env.E2E_M9_ADMIN_MEETINGS))
    expect(member.overview.totals.meetings).toBe(Number(env.E2E_M9_MEMBER_MEETINGS))
    expect(admin.overview.talkTime.coverage.withAnalytics).toBe(Number(env.E2E_M9_ADMIN_COVERAGE_WITH))
    expect(admin.overview.topics.map((topic) => topic.tag)).not.toContain("סודי")
  })

  it("gives the admin every notification kind and blanks the private meeting at read time", async (context) => {
    if (!db) return context.skip("PGlite did not load")

    const reader = {
      userId: "e2e_m9_admin",
      workspaceId: env.E2E_M9_W1_WORKSPACE_ID!,
      locale: "he",
      meetings: createPostgresMeetingRepository(db, {
        kind: "member",
        workspaceId: env.E2E_M9_W1_WORKSPACE_ID!,
        userId: "e2e_m9_admin",
        email: "m9-admin@example.test",
        role: "admin",
      }),
    }
    const backend = { kind: "postgres" as const, client: db }
    const { notifications } = await listNotifications(reader, { limit: 50 }, {
      backend,
      listMemberNames: async () => new Map(),
      getWorkspaceName: async () => "Other Co",
    })

    expect((await countUnreadNotifications(reader, backend)).count).toBe(Number(env.E2E_M9_ADMIN_UNREAD))
    expect(new Set(notifications.map((item) => item.kind))).toEqual(new Set(NOTIFICATION_KINDS))

    const hidden = notifications.find((item) => item.meeting?.id === env.E2E_M9_PRIVATE_MEETING_ID)

    expect(hidden?.meeting?.title).toBeNull()
    expect(hidden?.href).toBe("")
    expect(JSON.stringify(notifications)).not.toContain(env.E2E_M9_PRIVATE_MEETING_TITLE)
  })

  it("redirects only the fresh W3 owner to onboarding", async (context) => {
    if (!db) return context.skip("PGlite did not load")

    const progress = createPostgresOnboardingProgressStore(db)
    const ctx = (workspaceId: string, userId: string, email: string, role: "owner" | "admin") => ({
      principal: "user" as const,
      user: { id: userId, email },
      role,
      workspace: { id: workspaceId, name: "x", slug: "x" },
      meetings: createPostgresMeetingRepository(db!, { kind: "member", workspaceId, userId, email, role }),
    })
    const createdAt = async (id: string) => {
      const result = await db!.query<{ created_at: Date }>("select created_at from workspaces where id = $1", [id])
      return new Date(result.rows[0]!.created_at).toISOString()
    }

    expect(
      await computeOnboardingRedirect(ctx(env.E2E_M9_W3_WORKSPACE_ID!, "e2e_m9_fresh_owner", "m9-fresh@example.test", "owner"), {
        progress,
        workspaceCreatedAt: createdAt,
      })
    ).toBe(true)
    expect(
      await computeOnboardingRedirect(ctx(env.E2E_M9_W1_WORKSPACE_ID!, "e2e_m9_owner", "m9-owner@example.test", "owner"), {
        progress,
        workspaceCreatedAt: createdAt,
      })
    ).toBe(false)
  })

  it("stores a password hash only on the protected share", async (context) => {
    if (!db) return context.skip("PGlite did not load")

    const shares = await db.query<{ token: string; password_hash: string | null }>(
      "select token, password_hash from meeting_shares where token in ($1, $2)",
      [env.E2E_M9_SHARE_TOKEN, env.E2E_M9_PROTECTED_SHARE_TOKEN]
    )
    const byToken = Object.fromEntries(shares.rows.map((row) => [row.token, row.password_hash]))

    expect(byToken[env.E2E_M9_SHARE_TOKEN!]).toBeNull()
    expect(byToken[env.E2E_M9_PROTECTED_SHARE_TOKEN!]).toMatch(/^scrypt\$/)
    expect(byToken[env.E2E_M9_PROTECTED_SHARE_TOKEN!]).not.toContain(env.E2E_M9_SHARE_PASSWORD)
  })

  it("is idempotent", async (context) => {
    if (!db) return context.skip("PGlite did not load")

    await expect(seedM9E2E(db, { secret: "test-secret-0123456789abcdef0123456789" })).resolves.toBeTruthy()
  })
})
