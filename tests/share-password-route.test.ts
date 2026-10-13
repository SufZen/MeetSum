import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const audit = vi.hoisted(() => ({ entries: [] as unknown[] }))

vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>()

  return {
    ...actual,
    recordAuditLog: vi.fn(async (entry: unknown) => {
      audit.entries.push(entry)
    }),
  }
})

const lookup = vi.hoisted(() => ({ fn: undefined as undefined | ((token: string) => Promise<unknown>) }))

vi.mock("@/lib/sharing/public-share", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sharing/public-share")>()

  return {
    ...actual,
    lookupPublicShare: vi.fn(async (token: string) => (lookup.fn ? lookup.fn(token) : actual.lookupPublicShare(token))),
  }
})

import { PATCH as patchShare } from "@/app/api/meetings/[id]/share/route"
import { POST as verifyShare } from "@/app/api/share/[token]/verify/route"
import { updateAppSettings } from "@/lib/settings/app-settings"

const BASE = "http://localhost"
const PASSWORD = "סיסמה-חזקה-123"

function meetings() {
  return [
    testMeeting({ id: "m_mine", ownerUserId: "user_me", visibility: "link" }),
    testMeeting({ id: "m_other", ownerUserId: "user_owner", visibility: "workspace" }),
    testMeeting({ id: "m_private", ownerUserId: "user_owner", visibility: "private" }),
  ]
}

function patch(id: string, body: unknown, ip = "10.0.0.1") {
  const request = jsonRequest(`${BASE}/api/meetings/${id}/share`, "PATCH", body)

  request.headers.set("x-forwarded-for", ip)

  return patchShare(request, routeParams({ id }))
}

afterEach(() => {
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  audit.entries = []
  lookup.fn = undefined
  setRouteCtx(undefined)
  await updateAppSettings("ws_a", { publicSharingEnabled: true })
})

describe("PATCH /api/meetings/:id/share { password } (M9 B4)", () => {
  it("sets a password: the response says protected and never carries the hash", async () => {
    const ctx = await createTestCtx({ role: "member", meetings: meetings() })
    setRouteCtx(ctx)

    const response = await patch("m_mine", { password: PASSWORD })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.share.passwordProtected).toBe(true)
    expect(body.share).not.toHaveProperty("passwordHash")
    expect(JSON.stringify(body)).not.toContain("scrypt")

    const stored = await ctx.meetings.getShareByToken(body.share.token)
    expect(stored?.share.passwordHash).toMatch(/^scrypt\$32768\$8\$1\$/)
  })

  it("audits the change without the password or its hash", async () => {
    setRouteCtx(await createTestCtx({ role: "member", meetings: meetings() }))

    await patch("m_mine", { password: PASSWORD })
    await patch("m_mine", { password: null })

    const serialized = JSON.stringify(audit.entries)

    expect(audit.entries).toHaveLength(2)
    expect(serialized).toContain('"password":"set"')
    expect(serialized).toContain('"password":"cleared"')
    expect(serialized).not.toContain(PASSWORD)
    expect(serialized).not.toContain("scrypt")
  })

  it("clears the password", async () => {
    const ctx = await createTestCtx({ role: "member", meetings: meetings() })
    setRouteCtx(ctx)

    await patch("m_mine", { password: PASSWORD })
    const body = await (await patch("m_mine", { password: null })).json()
    const stored = await ctx.meetings.getShareByToken(body.share.token)

    expect(body.share.passwordProtected).toBe(false)
    expect(stored?.share.passwordHash).toBeUndefined()
  })

  it("rejects passwords outside 10–128 characters and non-strings", async () => {
    setRouteCtx(await createTestCtx({ role: "member", meetings: meetings() }))

    expect(await (await patch("m_mine", { password: "short" })).json()).toEqual({ error: "password_too_short" })
    expect((await patch("m_mine", { password: "x".repeat(129) })).status).toBe(400)
    expect((await patch("m_mine", { password: 12345678 })).status).toBe(400)
  })

  it("requires meeting:write (viewers 403), a manager (403) and a visible meeting (404)", async () => {
    setRouteCtx(await createTestCtx({ role: "viewer", meetings: meetings() }))
    expect((await patch("m_mine", { password: PASSWORD })).status).toBe(403)

    setRouteCtx(await createTestCtx({ role: "member", meetings: meetings() }))
    expect((await patch("m_other", { password: PASSWORD })).status).toBe(403)
    expect((await patch("m_private", { password: PASSWORD })).status).toBe(404)

    setRouteCtx(await createTestCtx({ role: "admin", meetings: meetings() }))
    expect((await patch("m_private", { password: PASSWORD })).status).toBe(404)
  })

  it("is rate limited with the exports preset", async () => {
    setRouteCtx(await createTestCtx({ role: "member", meetings: meetings() }))

    const statuses: number[] = []

    for (let i = 0; i < 22; i++) statuses.push((await patch("m_mine", { includedSections: ["summary"] }, "10.9.9.9")).status)

    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
  })

  it("verifies end-to-end: wrong password 403, right password sets the access cookie", async () => {
    const ctx = await createTestCtx({ role: "member", meetings: meetings() })
    setRouteCtx(ctx)

    const { share } = await (await patch("m_mine", { password: PASSWORD }, "10.1.1.1")).json()

    lookup.fn = (token) => ctx.meetings.getShareByToken(token)
    vi.stubEnv("MEETSUM_SESSION_SECRET", "share-password-route-test-secret")

    const verify = (password: string) =>
      verifyShare(jsonRequest(`${BASE}/api/share/${share.token}/verify`, "POST", { password }), routeParams({ token: share.token }))

    expect((await verify("wrong-password")).status).toBe(403)

    const ok = await verify(PASSWORD)

    expect(ok.status).toBe(200)
    expect(ok.headers.get("set-cookie")).toContain("meetsum_share_access=")
  })
})
