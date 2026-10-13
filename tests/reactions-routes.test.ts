import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

import { POST as react } from "@/app/api/reactions/route"
import { createCollabMemoryDb, setCollabBackendForTesting, type CollabMemoryDb } from "@/lib/clips/db"
import { createInMemoryMeetingDatabase, type InMemoryMeetingDatabase } from "@/lib/meetings/repository"

/** M5 C4 reactions: toggle, emoji allowlist, user principal, visibility. */

describe("POST /api/reactions", () => {
  let collab: CollabMemoryDb
  let database: InMemoryMeetingDatabase

  beforeEach(() => {
    collab = createCollabMemoryDb()
    setCollabBackendForTesting({ kind: "memory", db: collab })
    database = createInMemoryMeetingDatabase([
      testMeeting({ id: "m_a", transcript: [{ id: "s1", speaker: "A", startMs: 0, endMs: 1000, text: "hi" }] }),
      testMeeting({ id: "m_hidden", visibility: "private", ownerUserId: "user_owner" }),
    ])
  })

  afterEach(() => {
    setRouteCtx(undefined)
    setCollabBackendForTesting(undefined)
  })

  const send = (body: unknown) => react(jsonRequest("http://localhost/api/reactions", "POST", body), { params: Promise.resolve({}) })
  const thumbs = { meetingId: "m_a", targetType: "segment", targetId: "s1", emoji: "\u{1F44D}" }

  it("toggles a viewer's reaction on and off", async () => {
    setRouteCtx(await createTestCtx({ role: "viewer", database }))

    expect(await (await send(thumbs)).json()).toEqual({ active: true })
    expect(collab.reactions).toHaveLength(1)
    expect(await (await send(thumbs)).json()).toEqual({ active: false })
    expect(collab.reactions).toHaveLength(0)
  })

  it("accepts only the allowlist", async () => {
    setRouteCtx(await createTestCtx({ role: "viewer", database }))

    for (const emoji of ["\u{1F44D}", "❤️", "\u{1F3AF}", "✅", "❓", "\u{1F602}"]) {
      expect((await send({ ...thumbs, emoji })).status).toBe(200)
    }
    for (const emoji of ["\u{1F4A9}", "<script>", "", "❤"]) {
      expect(await (await send({ ...thumbs, emoji })).json()).toEqual({ error: "invalid_emoji" })
    }
  })

  it("rejects API keys, invisible meetings and unknown targets", async () => {
    setRouteCtx(await createTestCtx({ role: "member", principal: "api_key", database }))
    expect((await send(thumbs)).status).toBe(403)

    setRouteCtx(await createTestCtx({ role: "member", database }))
    expect((await send({ ...thumbs, meetingId: "m_hidden" })).status).toBe(404)
    expect((await send({ ...thumbs, targetId: "nope" })).status).toBe(400)
    expect((await send({ ...thumbs, targetType: "meeting", targetId: "m_a" })).status).toBe(400)
    expect((await send({ targetType: "segment" })).status).toBe(400)
  })
})
