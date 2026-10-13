/**
 * M9 C1 notification routes (docs/parity/m9.md): pagination, workspace
 * scoping, cross-workspace `invited`, the visibility re-check that blanks a
 * meeting title, API key 403 and mark read. Security check 4: notifications
 * are never visible to other users, and a title the reader cannot see is
 * never returned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

vi.mock("@/lib/workspaces/store", () => ({
  getWorkspaceStore: () => ({
    listMembers: async () => [
      { workspaceId: "ws_a", userId: "user_dana", role: "member", user: { id: "user_dana", email: "dana@x.example", name: "דנה" } },
    ],
    getWorkspace: async (id: string) => ({ id, name: id === "ws_b" ? "Acme B" : "A", slug: id }),
  }),
}))

import { GET as list } from "@/app/api/notifications/route"
import { POST as markRead } from "@/app/api/notifications/read/route"
import { GET as unreadCount } from "@/app/api/notifications/unread-count/route"
import { createCollabMemoryDb, setCollabBackendForTesting, type CollabMemoryDb } from "@/lib/clips/db"
import type { MemoryNotificationRow } from "@/lib/notifications/enqueue"
import { createInMemoryMeetingDatabase } from "@/lib/meetings/repository"
import type { NotificationDTO } from "@/lib/notifications/types"

const BASE = "http://localhost/api/notifications"
const route = { params: Promise.resolve({}) }

let collab: CollabMemoryDb

function row(id: string, extra: Partial<MemoryNotificationRow>): MemoryNotificationRow {
  return {
    id,
    workspaceId: "ws_a",
    userId: "user_me",
    kind: "mention",
    payload: {},
    createdAt: `2026-10-0${id.slice(-1)}T10:00:00.000Z`,
    ...extra,
  }
}

const meetings = createInMemoryMeetingDatabase([
  testMeeting({ id: "m_open", title: "Open meeting" }),
  testMeeting({ id: "m_secret", title: "Top secret plan", visibility: "private", ownerUserId: "user_other" }),
  testMeeting({ id: "m_b", title: "Other workspace", workspaceId: "ws_b" }),
])

beforeEach(async () => {
  collab = createCollabMemoryDb()
  collab.notifications.push(
    row("n1", { kind: "mention", meetingId: "m_open", actorUserId: "user_dana", payload: { meetingId: "m_open", commentId: "c1", startMs: 90_500 } }),
    row("n2", { kind: "meeting_processed", meetingId: "m_secret", payload: { meetingId: "m_secret", transcriptVersion: 1 } }),
    row("n3", { kind: "integration_reauth", payload: { connectionId: "k1", provider: "slack" } }),
    row("n4", { kind: "invited", workspaceId: "ws_b", payload: { invitationId: "inv_1", workspaceId: "ws_b", role: "member" } }),
    row("n5", { kind: "reply", workspaceId: "ws_b", meetingId: "m_b", payload: { meetingId: "m_b" } }),
    row("n6", { kind: "mention", userId: "user_dana", meetingId: "m_open", payload: { meetingId: "m_open" } })
  )
  setCollabBackendForTesting({ kind: "memory", db: collab })
  setRouteCtx(await createTestCtx({ workspaceId: "ws_a", database: meetings }))
})

afterEach(() => {
  setCollabBackendForTesting(undefined)
  setRouteCtx(undefined)
})

async function listJson(query = "") {
  const response = await list(new Request(`${BASE}?locale=he${query}`), route)

  return { status: response.status, body: (await response.json()) as { notifications: NotificationDTO[]; nextCursor: string | null } }
}

describe("GET /api/notifications", () => {
  it("returns only the caller's rows in this workspace plus invited from any workspace", async () => {
    const { body } = await listJson()

    expect(body.notifications.map((item) => item.id)).toEqual(["n4", "n3", "n2", "n1"])
  })

  it("blanks the title and link of a meeting the caller cannot see", async () => {
    const { body } = await listJson()
    const secret = body.notifications.find((item) => item.id === "n2")!

    expect(secret.meeting).toEqual({ id: "m_secret", title: null, language: null })
    expect(secret.href).toBe("")
    expect(JSON.stringify(body)).not.toContain("Top secret plan")
  })

  it("builds links and actor names from live data", async () => {
    const { body } = await listJson()
    const byId = Object.fromEntries(body.notifications.map((item) => [item.id, item]))

    expect(byId.n1?.meeting?.title).toBe("Open meeting")
    expect(byId.n1?.href).toBe("/he?meeting=m_open&t=90")
    expect(byId.n1?.actor).toEqual({ id: "user_dana", name: "דנה" })
    expect(byId.n3?.href).toBe("/he?panel=settings&section=integrations")
    expect(byId.n4?.href).toBe("/he/invite/accept?id=inv_1")
    expect(byId.n4?.payload.workspaceName).toBe("Acme B")
  })

  it("paginates with a cursor and filters unread", async () => {
    const first = await listJson("&limit=2")

    expect(first.body.notifications.map((item) => item.id)).toEqual(["n4", "n3"])
    expect(first.body.nextCursor).toBeTruthy()

    const second = await listJson(`&limit=2&cursor=${first.body.nextCursor}`)

    expect(second.body.notifications.map((item) => item.id)).toEqual(["n2", "n1"])
    expect(second.body.nextCursor).toBeNull()

    collab.notifications.find((item) => item.id === "n3")!.readAt = "2026-10-10T00:00:00.000Z"
    expect((await listJson("&unread=1")).body.notifications.map((item) => item.id)).toEqual(["n4", "n2", "n1"])
  })

  it("rejects a limit above 50", async () => {
    expect((await listJson("&limit=51")).status).toBe(400)
  })

  it("refuses API keys with 403 user_required", async () => {
    setRouteCtx(await createTestCtx({ principal: "api_key", role: "admin" }))

    for (const response of [
      await list(new Request(BASE), route),
      await unreadCount(new Request(`${BASE}/unread-count`), route),
      await markRead(new Request(`${BASE}/read`, { method: "POST", body: JSON.stringify({ all: true }) }), route),
    ]) {
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ reason: "user_required" })
    }
  })
})

describe("unread count and mark read", () => {
  it("counts unread with a weak ETag and answers 304 when unchanged", async () => {
    const response = await unreadCount(new Request(`${BASE}/unread-count`), route)
    const etag = response.headers.get("etag")!

    expect(await response.json()).toEqual({ count: 4 })
    expect(etag).toMatch(/^W\//)

    const cached = await unreadCount(new Request(`${BASE}/unread-count`, { headers: { "if-none-match": etag } }), route)

    expect(cached.status).toBe(304)
  })

  it("marks only the caller's rows, by id or all", async () => {
    const byId = await markRead(
      new Request(`${BASE}/read`, { method: "POST", body: JSON.stringify({ ids: ["n1", "n6", "n5"] }) }),
      route
    )

    expect(await byId.json()).toEqual({ updated: 1, unread: 3 })
    expect(collab.notifications.find((item) => item.id === "n6")?.readAt).toBeUndefined()
    expect(collab.notifications.find((item) => item.id === "n5")?.readAt).toBeUndefined()

    const all = await markRead(new Request(`${BASE}/read`, { method: "POST", body: JSON.stringify({ all: true }) }), route)

    expect(await all.json()).toEqual({ updated: 3, unread: 0 })
    expect(collab.notifications.find((item) => item.id === "n6")?.readAt).toBeUndefined()
  })

  it("rejects an invalid body", async () => {
    const response = await markRead(new Request(`${BASE}/read`, { method: "POST", body: "{}" }), route)

    expect(response.status).toBe(400)
  })
})
