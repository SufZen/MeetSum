/**
 * M9 A1: GET/PATCH /api/me/preferences (validation, API keys refused, cookie
 * refresh) and POST /api/user/locale persisting users.locale with a session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GET as getPreferences, PATCH as patchPreferences } from "@/app/api/me/preferences/route"
import { POST as postLocale } from "@/app/api/user/locale/route"
import { getUserPreferences, parsePreferencesPatch, resetMemoryUserPreferences } from "@/lib/users/preferences"
import { setWorkspaceStoreForTesting, type WorkspaceStore } from "@/lib/workspaces/store"
import type { WorkspaceUser } from "@/lib/workspaces/types"

import { TEST_SESSION_SECRET, freshStore, makeRequest, routeParams, seedWorkspace, sessionCookieFor } from "./helpers/workspace-auth"

const BASE = "http://localhost"
const noParams = routeParams({})

let store: WorkspaceStore
let owner: WorkspaceUser

beforeEach(async () => {
  store = freshStore()
  setWorkspaceStoreForTesting(store)
  vi.stubEnv("MEETSUM_SESSION_SECRET", TEST_SESSION_SECRET)
  vi.stubEnv("MEETSUM_STORAGE", "memory")
  resetMemoryUserPreferences()
  owner = (await seedWorkspace(store, "Acme", "owner@example.com")).owner
})

afterEach(() => {
  setWorkspaceStoreForTesting(undefined)
  vi.unstubAllEnvs()
})

const patch = (body: unknown, cookie = sessionCookieFor(owner)) =>
  patchPreferences(makeRequest(`${BASE}/api/me/preferences`, { method: "PATCH", cookie, body }), noParams)

describe("/api/me/preferences", () => {
  it("returns defaults, then the saved locale, zone and mutes", async () => {
    const initial = await (await getPreferences(makeRequest(`${BASE}/api/me/preferences`, { cookie: sessionCookieFor(owner) }), noParams)).json()

    expect(initial.preferences).toEqual({ locale: null, timeZone: null, notifications: { muted: [] } })

    const response = await patch({ locale: "en", timeZone: "Europe/Lisbon", notifications: { muted: ["reply", "reply"] } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.preferences).toEqual({ locale: "en", timeZone: "Europe/Lisbon", notifications: { muted: ["reply"] } })
    expect(response.headers.get("set-cookie")).toMatch(/meetsum_locale=en/)
    expect(await getUserPreferences(owner.id)).toEqual(body.preferences)
  })

  it("does not rewrite the cookie when the locale is unchanged", async () => {
    await patch({ locale: "he" })
    const response = await patch({ timeZone: "UTC" })

    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("rejects invalid zones, locales and notification kinds", async () => {
    for (const [body, field] of [
      [{ timeZone: "Mars/Olympus" }, "timeZone"],
      [{ timeZone: 3 }, "timeZone"],
      [{ locale: "pt" }, "locale"],
      [{ notifications: { muted: ["nope"] } }, "notifications"],
      [[], "body"],
    ] as const) {
      const response = await patch(body)

      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(await response.json()).toMatchObject({ error: "validation_failed", field })
    }
  })

  it("clears the locale and zone with null", async () => {
    await patch({ locale: "en", timeZone: "UTC" })
    const body = await (await patch({ locale: null, timeZone: null })).json()

    expect(body.preferences).toMatchObject({ locale: null, timeZone: null })
  })

  it("refuses API keys and anonymous callers", async () => {
    const withKey = await patchPreferences(
      makeRequest(`${BASE}/api/me/preferences`, { method: "PATCH", bearer: "msk_test", body: { locale: "en" } }),
      noParams
    )
    const anonymous = await getPreferences(makeRequest(`${BASE}/api/me/preferences`), noParams)

    expect(withKey.status).toBeGreaterThanOrEqual(401)
    expect(withKey.status).toBeLessThanOrEqual(403)
    expect(anonymous.status).toBe(401)
    expect(await getUserPreferences(owner.id)).toMatchObject({ locale: null })
  })
})

describe("parsePreferencesPatch", () => {
  it("ignores unknown fields", () => {
    expect(parsePreferencesPatch({ theme: "dark" })).toEqual({ ok: true, patch: {} })
  })
})

describe("POST /api/user/locale", () => {
  it("sets the cookie for anonymous callers without persisting", async () => {
    const response = await postLocale(makeRequest(`${BASE}/api/user/locale`, { method: "POST", body: { locale: "en" } }), noParams)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ locale: "en", persisted: false })
    expect(response.headers.get("set-cookie")).toMatch(/meetsum_locale=en/)
  })

  it("persists users.locale when a session is present", async () => {
    const response = await postLocale(
      makeRequest(`${BASE}/api/user/locale`, { method: "POST", cookie: sessionCookieFor(owner), body: { locale: "en" } }),
      noParams
    )

    expect(await response.json()).toEqual({ locale: "en", persisted: true })
    expect((await getUserPreferences(owner.id)).locale).toBe("en")
  })

  it("rejects unsupported locales", async () => {
    const response = await postLocale(makeRequest(`${BASE}/api/user/locale`, { method: "POST", body: { locale: "pt" } }), noParams)

    expect(response.status).toBe(400)
  })
})
