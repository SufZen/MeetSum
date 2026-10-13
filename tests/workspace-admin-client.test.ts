import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ApiError,
  createApiKey,
  createInvitation,
  listAuditLogs,
  normalizeMe,
  normalizePublicInvitation,
  scopeLevel,
  scopesFor,
  updateMeetingVisibility,
} from "@/components/admin/api"

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
  )
  vi.stubGlobal("fetch", fetchMock)

  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("admin API client", () => {
  it("normalizes GET /api/me", () => {
    const me = normalizeMe({
      user: { id: "u1", email: "dana@example.com", name: "דנה" },
      workspaces: [
        { id: "ws_a", name: "צוות", role: "admin" },
        { id: "ws_b", name: "Other", role: "bogus" },
      ],
      activeWorkspaceId: "ws_a",
      permissions: ["meeting:read", 42, "members:manage"],
    })

    expect(me.user).toMatchObject({ id: "u1", name: "דנה" })
    expect(me.workspaces[1].role).toBe("viewer")
    expect(me.permissions).toEqual(["meeting:read", "members:manage"])
  })

  it("maps API key scope levels to the admin ⊃ write ⊃ read hierarchy", () => {
    expect(scopesFor("admin")).toEqual(["read", "write", "admin"])
    expect(scopesFor("write")).toEqual(["read", "write"])
    expect(scopesFor("read")).toEqual(["read"])
    expect(scopeLevel(["read", "write"])).toBe("write")
  })

  it("sends scopes when creating an API key and returns the one-time key", async () => {
    const fetchMock = mockFetch(201, {
      key: "msk_secret",
      record: { id: "key_1", label: "CI", keyPrefix: "msk_", scopes: ["read"] },
    })

    const created = await createApiKey({ label: "CI", scope: "write" })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]

    expect(JSON.parse(String(init.body))).toMatchObject({
      label: "CI",
      scopes: ["read", "write"],
    })
    expect(created.rawKey).toBe("msk_secret")
  })

  it("keeps the invite URL when the invitation email could not be sent", async () => {
    mockFetch(201, {
      invitation: {
        id: "inv_1",
        email: "avi@example.com",
        role: "member",
        status: "pending",
        lastSendError: "smtp down",
      },
      inviteUrl: "https://meetsum.test/he/invite/inv_abc",
    })

    const created = await createInvitation({
      email: "avi@example.com",
      role: "member",
    })

    expect(created.inviteUrl).toBe("https://meetsum.test/he/invite/inv_abc")
    expect(created.emailSent).toBe(false)
    expect(created.sendError).toBe("smtp down")
  })

  it("passes audit filters and the cursor", async () => {
    const fetchMock = mockFetch(200, {
      logs: [{ id: "a1", action: "member.removed", createdAt: "2026-10-01" }],
      nextCursor: "c2",
    })

    const page = await listAuditLogs(
      { action: "member.removed", actor: " ", targetId: "u2" },
      "c1"
    )
    const [requested] = fetchMock.mock.calls[0] as unknown as [string]
    const url = new URL(requested, "http://x")

    expect(url.searchParams.get("action")).toBe("member.removed")
    expect(url.searchParams.has("actor")).toBe(false)
    expect(url.searchParams.get("before")).toBe("c1")
    expect(url.searchParams.has("cursor")).toBe(false)
    expect(page.nextCursor).toBe("c2")
  })

  it("raises ApiError with status and reason", async () => {
    mockFetch(403, { error: "Forbidden", reason: "meeting_manage_required" })

    const failure = await updateMeetingVisibility("m1", "private").catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({
      status: 403,
      code: "meeting_manage_required",
    })
  })

  it("normalizes a public invitation and never exposes owner role", () => {
    expect(
      normalizePublicInvitation({
        invitation: {
          workspace: { name: "צוות מכירות" },
          email: "a@b.c",
          role: "owner",
          status: "pending",
        },
      })
    ).toMatchObject({ workspaceName: "צוות מכירות", role: "admin" })
  })
})
