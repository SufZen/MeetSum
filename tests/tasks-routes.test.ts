import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createTestCtx,
  jsonRequest,
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
    { workspaceId: "ws_a", userId: "user_me", role: "member", user: { id: "user_me", email: "me@example.com" } },
    { workspaceId: "ws_a", userId: "user_dana", role: "member", user: { id: "user_dana", email: "dana@example.com", name: "Dana" } },
  ])
)

vi.mock("@/lib/audit", () => ({ recordAuditLog }))
vi.mock("@/lib/notifications/enqueue", () => ({ enqueueNotification }))
vi.mock("@/lib/workspaces/store", () => ({ getWorkspaceStore: () => ({ listMembers }) }))

import { POST as bulk } from "@/app/api/tasks/bulk/route"
import { GET as listTasks } from "@/app/api/tasks/route"
import {
  createInMemoryMeetingDatabase,
  type ActionItem,
  type InMemoryMeetingDatabase,
} from "@/lib/meetings/repository"
import type { TaskListPage } from "@/lib/tasks/types"

const BASE = "http://localhost/api/tasks"

function item(id: string, extra: Partial<ActionItem> = {}): ActionItem {
  return {
    id,
    title: `Task ${id}`,
    status: "open",
    origin: "ai",
    priority: "normal",
    createdAt: "2026-10-01T10:00:00.000Z",
    ...extra,
  }
}

function seed(): InMemoryMeetingDatabase {
  return createInMemoryMeetingDatabase([
    testMeeting({
      id: "m_room",
      title: "Room sync",
      contexts: [{ id: "ctx_1", name: "Lisboa", createdAt: "2026-10-01T00:00:00Z" }],
      summary: {
        overview: "",
        decisions: [],
        actionItems: [
          item("a_overdue", { dueOn: "2020-01-01", ownerUserId: "user_me" }),
          item("a_late", { dueOn: "2099-01-01" }),
          item("a_nodate", { createdByUserId: "user_me" }),
          item("a_done", { status: "done", ownerUserId: "user_me" }),
        ],
      },
    }),
    testMeeting({
      id: "m_other",
      summary: { overview: "", decisions: [], actionItems: [item("b_dana", { ownerUserId: "user_dana" })] },
    }),
    testMeeting({
      id: "m_private",
      ownerUserId: "user_other",
      visibility: "private",
      summary: { overview: "", decisions: [], actionItems: [item("p_secret", { ownerUserId: "user_me" })] },
    }),
    testMeeting({
      id: "m_foreign",
      workspaceId: "ws_b",
      summary: { overview: "", decisions: [], actionItems: [item("f_task", { ownerUserId: "user_me" })] },
    }),
  ])
}

async function useCtx(options: Parameters<typeof createTestCtx>[0] = {}, db = seed()) {
  setRouteCtx(await createTestCtx({ workspaceId: "ws_a", database: db, ...options }))
  return db
}

async function get(query: string): Promise<{ status: number; body: TaskListPage & { error?: string } }> {
  const response = await listTasks(new Request(`${BASE}?${query}`), { params: Promise.resolve({}) })

  return { status: response.status, body: (await response.json()) as TaskListPage & { error?: string } }
}

function post(body: unknown) {
  return bulk(jsonRequest(`${BASE}/bulk`, "POST", body), { params: Promise.resolve({}) })
}

beforeAll(() => {
  process.env.MEETSUM_RATE_LIMIT = "false"
})

beforeEach(() => {
  setRouteCtx(undefined)
  recordAuditLog.mockClear()
  enqueueNotification.mockClear()
})

describe("GET /api/tasks", () => {
  it("lists open tasks of visible meetings only, due first then undated", async () => {
    await useCtx({ role: "viewer" })
    const { status, body } = await get("scope=all&status=open")

    expect(status).toBe(200)
    expect(body.tasks.map((task) => task.id)).toEqual(["a_overdue", "a_late", "b_dana", "a_nodate"])
    expect(body.tasks[0].meeting).toMatchObject({ id: "m_room", title: "Room sync" })
  })

  it("filters mine, overdue, room, owner and search", async () => {
    await useCtx()

    expect((await get("scope=mine&status=all")).body.tasks.map((task) => task.id)).toEqual([
      "a_overdue",
      "a_nodate",
      "a_done",
    ])
    expect((await get("status=overdue")).body.tasks.map((task) => task.id)).toEqual(["a_overdue"])
    expect((await get("status=all&roomId=ctx_1")).body.tasks).toHaveLength(4)
    expect((await get("ownerUserId=user_dana")).body.tasks.map((task) => task.id)).toEqual(["b_dana"])
    expect((await get("q=a_late")).body.tasks.map((task) => task.id)).toEqual(["a_late"])
  })

  it("pages with a cursor", async () => {
    await useCtx()
    const first = await get("limit=2")

    expect(first.body.tasks).toHaveLength(2)
    const second = await get(`limit=2&cursor=${first.body.nextCursor}`)

    expect(second.body.tasks.map((task) => task.id)).toEqual(["b_dana", "a_nodate"])
    expect(second.body.nextCursor).toBeUndefined()
  })

  it("validates the query", async () => {
    await useCtx()

    expect((await get("status=late")).status).toBe(400)
    expect((await get("limit=500")).status).toBe(400)
    expect((await get("dueFrom=yesterday")).status).toBe(400)
    expect((await get("cursor=garbage")).status).toBe(400)
  })
})

describe("POST /api/tasks/bulk", () => {
  it("completes visible tasks and reports invisible or foreign ids as not found", async () => {
    const db = await useCtx()
    const response = await post({
      ids: ["a_late", "b_dana", "p_secret", "f_task", "nope"],
      patch: { status: "done" },
    })
    const body = (await response.json()) as { updated: ActionItem[]; notFound: string[] }

    expect(response.status).toBe(200)
    expect(body.updated.map((task) => task.id)).toEqual(["a_late", "b_dana"])
    expect(body.notFound).toEqual(["p_secret", "f_task", "nope"])
    expect(db.meetings.get("m_private")?.summary?.actionItems[0].status).toBe("open")
    expect(db.meetings.get("m_foreign")?.summary?.actionItems[0].status).toBe("open")
    expect(recordAuditLog).toHaveBeenCalledTimes(2)
  })

  it("reassigns to a member, sets due dates, and validates", async () => {
    await useCtx()
    const response = await post({ ids: ["a_late"], patch: { ownerUserId: "user_dana", dueOn: "2026-11-01" } })
    const body = (await response.json()) as { updated: ActionItem[] }

    expect(body.updated[0]).toMatchObject({
      ownerUserId: "user_dana",
      owner: "Dana",
      dueOn: "2026-11-01",
      dueSource: "user",
      editedByUser: true,
    })
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_dana", kind: "task_assigned" })
    )

    expect((await post({ ids: ["a_late"], patch: { ownerUserId: "user_x" } })).status).toBe(400)
    expect((await post({ ids: [], patch: { status: "done" } })).status).toBe(400)
    expect((await post({ ids: ["a_late"], patch: {} })).status).toBe(400)
    expect(
      (await post({ ids: Array.from({ length: 101 }, (_, index) => `id_${index}`), patch: { status: "done" } }))
        .status
    ).toBe(400)
  })

  it("is 403 for viewers", async () => {
    await useCtx({ role: "viewer" })

    expect((await post({ ids: ["a_late"], patch: { status: "done" } })).status).toBe(403)
  })

  it("sends no notification for a status-only update of assigned tasks", async () => {
    await useCtx()
    const response = await post({ ids: ["b_dana", "a_late"], patch: { status: "done" } })

    expect(response.status).toBe(200)
    expect(enqueueNotification).not.toHaveBeenCalled()
  })

  it("notifies only items whose owner actually changes", async () => {
    await useCtx()
    const response = await post({ ids: ["b_dana", "a_late"], patch: { ownerUserId: "user_dana" } })
    const body = (await response.json()) as { updated: ActionItem[] }

    expect(body.updated.map((task) => task.id)).toEqual(["b_dana", "a_late"])
    expect(enqueueNotification).toHaveBeenCalledTimes(1)
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_dana",
        kind: "task_assigned",
        payload: expect.objectContaining({ actionItemId: "a_late" }),
      })
    )
  })

  it("reports a storage failure as a 500, not as not found", async () => {
    const db = await useCtx()
    const ctx = await createTestCtx({ workspaceId: "ws_a", database: db })

    ctx.meetings.updateActionItem = async () => {
      throw new Error("connection terminated")
    }
    setRouteCtx(ctx)

    const response = await post({ ids: ["a_late"], patch: { status: "done" } })

    expect(response.status).toBe(500)
  })
})
