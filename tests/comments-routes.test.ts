import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const recordAuditLog = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock("@/lib/audit", () => ({ recordAuditLog }))
vi.mock("@/lib/workspaces/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspaces/store")>()
  const members = [
    { userId: "user_me", role: "viewer", workspaceId: "ws_a", user: { id: "user_me", email: "me@example.com", name: "מיכל" } },
    { userId: "user_dana", role: "member", workspaceId: "ws_a", user: { id: "user_dana", email: "dana@example.com" } },
    { userId: "user_admin", role: "admin", workspaceId: "ws_a", user: { id: "user_admin", email: "admin@example.com", name: "Admin" } },
  ]

  return { ...actual, getWorkspaceStore: () => ({ listMembers: async () => members }) }
})

import { DELETE as deleteComment, PATCH as patchComment } from "@/app/api/comments/[id]/route"
import { GET as listComments, POST as postComment } from "@/app/api/meetings/[id]/comments/route"
import { CommentBody } from "@/components/comments/comment-thread"
import { createCollabMemoryDb, setCollabBackendForTesting, type CollabMemoryDb } from "@/lib/clips/db"
import { createInMemoryMeetingDatabase, type InMemoryMeetingDatabase } from "@/lib/meetings/repository"
import type { WorkspaceRole } from "@/lib/workspaces/types"

/**
 * M5 C3 comment routes: viewers can comment, API keys get 403
 * `user_required`, invisible meetings 404, mentions limited to members with
 * notification rows, audit entries without comment text, author/admin
 * delete and member resolve, and escaped rendering of hostile bodies.
 */

const BASE = "http://localhost/api"

describe("comment routes", () => {
  let collab: CollabMemoryDb
  let database: InMemoryMeetingDatabase

  beforeEach(() => {
    vi.clearAllMocks()
    collab = createCollabMemoryDb()
    setCollabBackendForTesting({ kind: "memory", db: collab })
    database = createInMemoryMeetingDatabase([
      testMeeting({
        id: "m_a",
        transcript: [{ id: "s1", speaker: "Dana", startMs: 0, endMs: 3000, text: "נתחיל" }],
      }),
      testMeeting({ id: "m_hidden", visibility: "private", ownerUserId: "user_owner" }),
    ])
  })

  afterEach(() => {
    setRouteCtx(undefined)
    setCollabBackendForTesting(undefined)
  })

  async function as(role: WorkspaceRole, userId = "user_me", principal: "user" | "api_key" = "user") {
    setRouteCtx(await createTestCtx({ role, userId, principal, database }))
  }

  const post = (meetingId: string, body: unknown) =>
    postComment(jsonRequest(`${BASE}/meetings/${meetingId}/comments`, "POST", body), routeParams({ id: meetingId }))

  it("lets a viewer comment and mention members; audit carries no text", async () => {
    await as("viewer")

    const response = await post("m_a", {
      targetType: "segment",
      targetId: "s1",
      body: "סוד: @[Dana](user:user_dana) @[X](user:user_x)",
    })
    const { comment } = await response.json()

    expect(response.status).toBe(201)
    expect(comment.mentions).toEqual(["user_dana"])
    expect(comment.body).toBe("סוד: @[Dana](user:user_dana) @X")
    expect(collab.notifications).toHaveLength(1)
    expect(collab.notifications[0]).toMatchObject({ userId: "user_dana", kind: "mention" })
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "comment.created", workspaceId: "ws_a", targetId: comment.id })
    )
    expect(JSON.stringify(recordAuditLog.mock.calls)).not.toContain("סוד")
  })

  it("rejects API keys even with a write scope", async () => {
    await as("member", "user_me", "api_key")

    const response = await post("m_a", { targetType: "segment", targetId: "s1", body: "x" })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ reason: "user_required" })
    expect(
      (await listComments(new Request(`${BASE}/meetings/m_a/comments`), routeParams({ id: "m_a" }))).status
    ).toBe(403)
  })

  it("answers 404 for invisible meetings and 400 for bad targets", async () => {
    await as("member")

    expect((await post("m_hidden", { targetType: "meeting", targetId: "m_hidden", body: "x" })).status).toBe(404)
    expect(await (await post("m_a", { targetType: "segment", targetId: "nope", body: "x" })).json()).toEqual({
      error: "invalid_target",
    })
    expect((await post("m_a", { targetType: "bogus", targetId: "s1", body: "x" })).status).toBe(400)
  })

  it("lists threads with author names and the viewer id", async () => {
    await as("viewer")
    await post("m_a", { targetType: "segment", targetId: "s1", body: "שלום" })

    const response = await listComments(new Request(`${BASE}/meetings/m_a/comments`), routeParams({ id: "m_a" }))
    const body = await response.json()

    expect(body.viewerUserId).toBe("user_me")
    expect(body.threads["segment:s1"][0]).toMatchObject({ body: "שלום", authorUserId: "user_me" })
    expect(body.authors.user_me).toEqual({ name: "מיכל" })
    expect(body.authors.user_dana).toEqual({ name: "dana" })
  })

  it("enforces edit / resolve / delete rights", async () => {
    await as("viewer")

    const { comment } = await (await post("m_a", { targetType: "segment", targetId: "s1", body: "a" })).json()
    const patch = (body: unknown) =>
      patchComment(jsonRequest(`${BASE}/comments/${comment.id}`, "PATCH", body), routeParams({ id: comment.id }))
    const remove = () =>
      deleteComment(new Request(`${BASE}/comments/${comment.id}`, { method: "DELETE" }), routeParams({ id: comment.id }))

    expect((await patch({ resolved: true })).status).toBe(403)
    expect(await (await patch({ body: "b" })).json()).toMatchObject({ comment: { body: "b" } })

    await as("member", "user_dana")
    expect((await patch({ body: "hijack" })).status).toBe(403)
    expect((await patch({ resolved: true })).status).toBe(200)
    expect((await remove()).status).toBe(403)

    await as("admin", "user_admin")
    expect((await remove()).status).toBe(200)
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "comment.deleted" }))
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "comment.resolved", metadata: { meetingId: "m_a", resolved: true } })
    )
  })

  it("renders hostile bodies as escaped text with mention chips", () => {
    const html = renderToStaticMarkup(
      createElement(CommentBody, {
        body: '<img src=x onerror="alert(1)"> @[The CEO](user:user_dana)',
        directory: { user_dana: { name: "דנה" } },
      })
    )

    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
    expect(html).toMatch(/<bdi[^>]*>@דנה<\/bdi>/)
    expect(html).not.toContain("user:user_dana")
    // The chip shows the member directory name, not the author-supplied text.
    expect(html).not.toContain("The CEO")
  })
})
