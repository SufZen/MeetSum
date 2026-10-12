import { afterEach, describe, expect, it, vi } from "vitest"

import { getAllowedEmails } from "@/lib/auth/session"
import {
  allowedRequestSubjects,
  resolveRequestWorkspaceSubject,
} from "@/lib/google/request-subject"
import {
  getWorkspaceGoogleSubject,
  loadWorkspaceGoogleSubject,
} from "@/lib/google/workspace-subject"

type Ctx = Parameters<typeof resolveRequestWorkspaceSubject>[0]

function sessionCtx(options: {
  workspaceId?: string
  googleSubject?: string
  email?: string
}): Ctx {
  return {
    workspace: {
      id: options.workspaceId ?? "ws_1",
      name: "W1",
      slug: "w1",
      googleSubject: options.googleSubject,
    },
    user: options.email ? { id: "user_1", email: options.email } : undefined,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("resolveRequestWorkspaceSubject", () => {
  it("lets a session user name their own mailbox or the workspace subject", () => {
    const ctx = sessionCtx({
      googleSubject: "admin@example.test",
      email: "user@example.test",
    })

    expect(resolveRequestWorkspaceSubject(ctx, "User@Example.test")).toEqual({
      subject: "user@example.test",
    })
    expect(resolveRequestWorkspaceSubject(ctx, "admin@example.test")).toEqual({
      subject: "admin@example.test",
    })
  })

  it("ignores a subject belonging to someone else", () => {
    const ctx = sessionCtx({
      googleSubject: "admin@example.test",
      email: "user@example.test",
    })

    expect(resolveRequestWorkspaceSubject(ctx, "ceo@example.test")).toEqual({
      subject: "admin@example.test",
    })
  })

  it("never lets an API key pass an arbitrary subject", () => {
    const apiKeyCtx = sessionCtx({ googleSubject: "admin@example.test" })

    expect(allowedRequestSubjects(apiKeyCtx)).toEqual(["admin@example.test"])
    expect(resolveRequestWorkspaceSubject(apiKeyCtx, "ceo@example.test")).toEqual({
      subject: "admin@example.test",
    })
  })

  it("answers 409 google_not_configured for an API key without a workspace subject", async () => {
    const result = resolveRequestWorkspaceSubject(
      sessionCtx({ workspaceId: "ws_2" }),
      "ceo@example.test"
    )

    expect("response" in result && result.response.status).toBe(409)
    if ("response" in result) {
      expect(await result.response.json()).toMatchObject({
        error: "google_not_configured",
      })
    }
  })

  it("requires the workspace subject for workspace-wide syncs", () => {
    const result = resolveRequestWorkspaceSubject(
      sessionCtx({ workspaceId: "ws_2", email: "user@example.test" }),
      "user@example.test",
      { requireWorkspaceSubject: true }
    )

    expect("response" in result && result.response.status).toBe(409)
  })

  it("falls back to the user's own mailbox when no workspace subject is set", () => {
    expect(
      resolveRequestWorkspaceSubject(
        sessionCtx({ workspaceId: "ws_2", email: "user@example.test" }),
        undefined
      )
    ).toEqual({ subject: "user@example.test" })
  })

  it("never applies the env subject to a non-default workspace", () => {
    vi.stubEnv("GOOGLE_WORKSPACE_SUBJECT", "boot@example.test")

    expect(getWorkspaceGoogleSubject({ id: "ws_default" })).toBe("boot@example.test")
    expect(getWorkspaceGoogleSubject({ id: "ws_2" })).toBeUndefined()
    expect(
      resolveRequestWorkspaceSubject(sessionCtx({ workspaceId: "ws_2" }), "boot@example.test")
    ).toHaveProperty("response")
  })
})

describe("loadWorkspaceGoogleSubject", () => {
  it("reads workspaces.google_subject of a live workspace", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ google_subject: "Owner@W2.test" }] })

    await expect(
      loadWorkspaceGoogleSubject("ws_2", {
        env: { MEETSUM_STORAGE: "postgres" } as unknown as NodeJS.ProcessEnv,
        db: { query },
      })
    ).resolves.toBe("owner@w2.test")
    expect(query.mock.calls[0][0]).toMatch(/deleted_at is null/)
    expect(query.mock.calls[0][1]).toEqual(["ws_2"])
  })

  it("returns undefined for an unknown or unconfigured workspace", async () => {
    const env = { MEETSUM_STORAGE: "postgres" } as unknown as NodeJS.ProcessEnv

    await expect(
      loadWorkspaceGoogleSubject("ws_x", { env, db: { query: async () => ({ rows: [] }) } })
    ).resolves.toBeUndefined()
    await expect(
      loadWorkspaceGoogleSubject("ws_2", {
        env,
        db: { query: async () => ({ rows: [{ google_subject: null }] }) },
      })
    ).resolves.toBeUndefined()
  })
})

describe("getAllowedEmails", () => {
  it("treats a blank allowlist as unset and falls back to the workspace subject", () => {
    expect(
      getAllowedEmails({
        MEETSUM_ALLOWED_EMAILS: " ",
        GOOGLE_WORKSPACE_SUBJECT: "admin@example.test",
      } as unknown as NodeJS.ProcessEnv)
    ).toEqual(["admin@example.test"])
  })
})
