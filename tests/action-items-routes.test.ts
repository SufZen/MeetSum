import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createTestCtx,
  jsonRequest,
  routeParams,
  setRouteCtx,
  testMeeting,
} from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const recordAuditLog = vi.hoisted(() => vi.fn(async (input: unknown) => input))
const enqueueNotification = vi.hoisted(() => vi.fn(async () => ({ skipped: false })))
const listMembers = vi.hoisted(() =>
  vi.fn(async () => [
    { workspaceId: "ws_a", userId: "user_me", role: "member", user: { id: "user_me", email: "me@example.com", name: "Me" } },
    { workspaceId: "ws_a", userId: "user_dana", role: "member", user: { id: "user_dana", email: "dana@example.com", name: "דנה כהן" } },
  ])
)

vi.mock("@/lib/audit", () => ({ recordAuditLog }))
vi.mock("@/lib/notifications/enqueue", () => ({ enqueueNotification }))
vi.mock("@/lib/workspaces/store", () => ({ getWorkspaceStore: () => ({ listMembers }) }))

import { DELETE, PATCH } from "@/app/api/action-items/[id]/route"
import { GET as listItems, POST as createItem } from "@/app/api/meetings/[id]/action-items/route"
import {
  createInMemoryMeetingDatabase,
  type ActionItem,
  type InMemoryMeetingDatabase,
} from "@/lib/meetings/repository"

const BASE = "http://localhost/api"

function aiItem(id: string, title: string, extra: Partial<ActionItem> = {}): ActionItem {
  return { id, title, status: "open", origin: "ai", editedByUser: false, priority: "normal", ...extra }
}

function seed(): InMemoryMeetingDatabase {
  return createInMemoryMeetingDatabase([
    testMeeting({
      id: "m_thu",
      // Thursday 15.10.2026, 12:00 Jerusalem.
      startedAt: "2026-10-15T09:00:00.000Z",
      participants: ["dana@example.com"],
      summary: { overview: "", decisions: [], actionItems: [aiItem("ai_1", "לשלוח הצעה")] },
    }),
    testMeeting({
      id: "m_private",
      ownerUserId: "user_other",
      visibility: "private",
      summary: { overview: "", decisions: [], actionItems: [aiItem("ai_private", "סודי")] },
    }),
    testMeeting({
      id: "m_foreign",
      workspaceId: "ws_b",
      summary: { overview: "", decisions: [], actionItems: [aiItem("ai_foreign", "זר")] },
    }),
  ])
}

async function useCtx(options: Parameters<typeof createTestCtx>[0] = {}, db = seed()) {
  setRouteCtx(await createTestCtx({ workspaceId: "ws_a", database: db, ...options }))
  return db
}

function patch(id: string, body: unknown) {
  return PATCH(jsonRequest(`${BASE}/action-items/${id}`, "PATCH", body), routeParams({ id }))
}

function remove(id: string, meetingId: string) {
  return DELETE(
    new Request(`${BASE}/action-items/${id}?meetingId=${meetingId}`, { method: "DELETE" }),
    routeParams({ id })
  )
}

function create(meetingId: string, body: unknown) {
  return createItem(
    jsonRequest(`${BASE}/meetings/${meetingId}/action-items`, "POST", body),
    routeParams({ id: meetingId })
  )
}

beforeAll(() => {
  process.env.MEETSUM_RATE_LIMIT = "false"
})

beforeEach(() => {
  setRouteCtx(undefined)
  recordAuditLog.mockClear()
  enqueueNotification.mockClear()
  listMembers.mockClear()
})

describe("PATCH /api/action-items/:id", () => {
  it("parses 'עד יום ראשון' against the meeting start and marks the item user-edited", async () => {
    const db = await useCtx()
    const response = await patch("ai_1", { meetingId: "m_thu", dueText: "עד יום ראשון" })

    expect(response.status).toBe(200)
    const { actionItem } = (await response.json()) as { actionItem: ActionItem }

    expect(actionItem).toMatchObject({
      dueOn: "2026-10-18",
      dueText: "עד יום ראשון",
      dueSource: "user",
      editedByUser: true,
    })
    expect(db.meetings.get("m_thu")?.summary?.actionItems[0]).toMatchObject({ editedByUser: true })
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "action_item.updated",
        workspaceId: "ws_a",
        targetId: "ai_1",
      })
    )
  })

  it("assigns a workspace member and notifies them", async () => {
    await useCtx()
    const response = await patch("ai_1", { meetingId: "m_thu", ownerUserId: "user_dana" })
    const { actionItem } = (await response.json()) as { actionItem: ActionItem }

    expect(response.status).toBe(200)
    expect(actionItem).toMatchObject({ ownerUserId: "user_dana", owner: "דנה כהן", editedByUser: true })
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_dana", kind: "task_assigned", workspaceId: "ws_a" })
    )
  })

  it("does not notify when assigning to yourself", async () => {
    await useCtx()
    await patch("ai_1", { meetingId: "m_thu", ownerUserId: "user_me" })

    expect(enqueueNotification).not.toHaveBeenCalled()
  })

  it("rejects a non-member owner and an unknown participant", async () => {
    await useCtx()

    expect((await patch("ai_1", { meetingId: "m_thu", ownerUserId: "user_stranger" })).status).toBe(400)
    expect(
      (await patch("ai_1", { meetingId: "m_thu", ownerParticipantId: "participant_nope" })).status
    ).toBe(400)
  })

  it("validates the body", async () => {
    await useCtx()

    expect((await patch("ai_1", { meetingId: "m_thu", dueOn: "18/10/2026" })).status).toBe(400)
    expect((await patch("ai_1", { meetingId: "m_thu", priority: "asap" })).status).toBe(400)
    expect((await patch("ai_1", { dueOn: "2026-10-18" })).status).toBe(400)
  })

  it("is 403 for viewers", async () => {
    await useCtx({ role: "viewer" })

    expect((await patch("ai_1", { meetingId: "m_thu", title: "x" })).status).toBe(403)
  })

  it("is 404 for invisible or foreign meetings and for items of another meeting", async () => {
    const db = await useCtx()

    expect((await patch("ai_private", { meetingId: "m_private", title: "x" })).status).toBe(404)
    expect((await patch("ai_foreign", { meetingId: "m_foreign", title: "x" })).status).toBe(404)
    expect((await patch("ai_private", { meetingId: "m_thu", title: "x" })).status).toBe(404)
    expect(db.meetings.get("m_private")?.summary?.actionItems[0].title).toBe("סודי")
  })
})

describe("DELETE /api/action-items/:id", () => {
  it("deletes a visible item and audits it", async () => {
    const db = await useCtx()
    const response = await remove("ai_1", "m_thu")

    expect(response.status).toBe(200)
    expect(db.meetings.get("m_thu")?.summary?.actionItems).toEqual([])
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "action_item.deleted", targetId: "ai_1" })
    )
  })

  it("is 404 for invisible meetings and 403 for viewers", async () => {
    await useCtx()
    expect((await remove("ai_private", "m_private")).status).toBe(404)

    await useCtx({ role: "viewer" })
    expect((await remove("ai_1", "m_thu")).status).toBe(403)
  })
})

describe("POST /api/meetings/:id/action-items", () => {
  it("creates a user task with a parsed due date", async () => {
    const db = await useCtx()
    const response = await create("m_thu", { title: "לתאם פגישה", dueText: "שבוע הבא", ownerUserId: "user_dana" })

    expect(response.status).toBe(201)
    const { actionItem } = (await response.json()) as { actionItem: ActionItem }

    expect(actionItem).toMatchObject({
      title: "לתאם פגישה",
      origin: "user",
      editedByUser: true,
      dueOn: "2026-10-22",
      dueSource: "user",
      ownerUserId: "user_dana",
      ownerText: "דנה כהן",
      workspaceId: "ws_a",
      createdByUserId: "user_me",
    })
    expect(db.meetings.get("m_thu")?.summary?.actionItems).toHaveLength(2)
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "action_item.created", workspaceId: "ws_a" })
    )
  })

  it("rejects an empty title, 403s viewers and 404s invisible meetings", async () => {
    await useCtx()
    expect((await create("m_thu", { title: "  " })).status).toBe(400)
    expect((await create("m_private", { title: "x" })).status).toBe(404)
    expect((await create("m_foreign", { title: "x" })).status).toBe(404)

    await useCtx({ role: "viewer" })
    expect((await create("m_thu", { title: "x" })).status).toBe(403)
  })

  it("lists a visible meeting's items and 404s an invisible one", async () => {
    await useCtx({ role: "viewer" })

    const ok = await listItems(new Request(`${BASE}/meetings/m_thu/action-items`), routeParams({ id: "m_thu" }))
    const hidden = await listItems(
      new Request(`${BASE}/meetings/m_private/action-items`),
      routeParams({ id: "m_private" })
    )

    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { actionItems: ActionItem[] }).actionItems).toHaveLength(1)
    expect(hidden.status).toBe(404)
  })
})
