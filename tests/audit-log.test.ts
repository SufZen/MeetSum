import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values: unknown[] }>,
  rows: [] as unknown[],
}))

vi.mock("@/lib/db/client", () => ({
  getDatabasePool: () => ({
    query: async (text: string, values: unknown[] = []) => {
      db.queries.push({ text, values })
      return { rows: db.rows }
    },
  }),
}))

import {
  decodeAuditCursor,
  listAuditLogs,
  listAuditLogsPage,
  recordAuditLog,
  type AuditAction,
} from "@/lib/audit"

describe("workspace audit store (postgres)", () => {
  beforeEach(() => {
    process.env.MEETSUM_STORAGE = "postgres"
    db.queries.length = 0
    db.rows = []
  })

  afterEach(() => {
    delete process.env.MEETSUM_STORAGE
  })

  it("persists workspace and actor columns", async () => {
    await recordAuditLog({
      action: "member.removed",
      actor: "owner@example.com",
      workspaceId: "ws_a",
      actorUserId: "user_owner",
      actorApiKeyId: "key_1",
      targetType: "user",
      targetId: "user_x",
    })

    expect(db.queries[0].text).toContain("workspace_id, actor_user_id, actor_api_key_id")
    expect(db.queries[0].values.slice(6)).toEqual(["ws_a", "user_owner", "key_1"])
  })

  it("always filters by workspace and applies the optional filters", async () => {
    await listAuditLogs({
      workspaceId: "ws_a",
      action: "member.removed",
      actor: "user_owner",
      targetType: "user",
      targetId: "user_x",
      limit: 10,
    })

    const { text, values } = db.queries[0]

    expect(text).toContain("workspace_id = $1")
    expect(text).toContain("actor_user_id = $3")
    expect(text).toContain("order by created_at desc, id desc")
    expect(values).toEqual(["ws_a", "member.removed", "user_owner", "user", "user_x", 11])
  })

  it("paginates newest-first with an opaque keyset cursor", async () => {
    db.rows = [
      { id: "audit_3", action: "meeting.created", created_at: new Date("2026-05-03T00:00:00.000Z"), workspace_id: "ws_a" },
      { id: "audit_2", action: "meeting.created", created_at: new Date("2026-05-02T00:00:00.000Z"), workspace_id: "ws_a" },
      { id: "audit_1", action: "meeting.created", created_at: new Date("2026-05-01T00:00:00.000Z"), workspace_id: "ws_a" },
    ]

    const page = await listAuditLogsPage({ workspaceId: "ws_a", limit: 2 })

    expect(page.logs.map((log) => log.id)).toEqual(["audit_3", "audit_2"])
    expect(page.nextCursor).toBeDefined()
    expect(decodeAuditCursor(page.nextCursor!)).toEqual({
      createdAt: "2026-05-02T00:00:00.000Z",
      id: "audit_2",
    })

    db.rows = []
    const last = await listAuditLogsPage({
      workspaceId: "ws_a",
      limit: 2,
      before: page.nextCursor,
    })
    const next = db.queries[1]

    expect(last.nextCursor).toBeUndefined()
    expect(next.text).toContain("(created_at, id) < ($2::timestamptz, $3)")
    expect(next.values).toEqual(["ws_a", "2026-05-02T00:00:00.000Z", "audit_2", 3])
  })

  it("defaults to the default workspace until integration and rejects bad cursors", async () => {
    await listAuditLogs()

    expect(db.queries[0].values[0]).toBe("ws_default")
    await expect(
      listAuditLogsPage({ workspaceId: "ws_a", before: "garbage" })
    ).rejects.toThrow("Invalid audit log cursor")
  })
})

describe("audit log types", () => {
  it("defines all expected core action categories", () => {
    // Type-level check — if these don't compile, actions are missing
    const coreActions: AuditAction[] = [
      "meeting.created",
      "meeting.processed",
      "meeting.reprocessed",
      "meeting.deleted",
      "meeting.share.created",
      "meeting.share.updated",
      "meeting.share.revoked",
      "meeting.share.accessed",
      "meeting.export.markdown",
      "meeting.export.pdf",
      "room.created",
      "room.meeting.added",
    ]

    expect(coreActions.length).toBeGreaterThanOrEqual(12)
  })

  it("defines integration audit actions", () => {
    const integrationActions: AuditAction[] = [
      "webhook.subscription.created",
      "webhook.subscription.updated",
      "webhook.delivery.retried",
      "webhook.test.sent",
      "realizeos.export.queued",
      "realizeos.export.sent",
      "realizeos.export.failed",
      "realizeos.export.retried",
    ]

    expect(integrationActions.length).toBeGreaterThanOrEqual(8)
  })

  it("defines admin and auth audit actions", () => {
    const adminActions: AuditAction[] = [
      "auth.session.created",
      "auth.session.refreshed",
      "admin.settings.updated",
    ]

    expect(adminActions.length).toBe(3)
  })
})
