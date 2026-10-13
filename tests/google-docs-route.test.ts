import { readFileSync } from "node:fs"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"
import { connectionDto, json, memoryLinkStore, on, scriptedFetch } from "./helpers/integration-doubles"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const { recordAuditLog, delegated, authStatus } = vi.hoisted(() => ({
  recordAuditLog: vi.fn(),
  delegated: vi.fn(),
  authStatus: vi.fn(() => ({ strategy: "json-key" })),
}))

vi.mock("@/lib/audit", () => ({ recordAuditLog }))
vi.mock("@/lib/google/auth", () => ({
  createDelegatedGoogleClient: delegated,
  getWorkspaceAuthStatus: authStatus,
}))

import { POST as exportDocs } from "@/app/api/meetings/[id]/export/google-docs/route"
import type { IntegrationConnectionDTO } from "@/lib/integrations/core/types"
import {
  exchangeGoogleDocsCode,
  googleDocsAuthorizeUrl,
  refreshGoogleDocsToken,
} from "@/lib/integrations/google-docs/oauth"
import { setManualExportRuntime, type ManualExportRuntime } from "@/lib/integrations/notion/manual-export-runtime"

/**
 * M8 C2: Google Docs export from the requester's own connection (or the DWD
 * path inside the workspace domain); not connected → 409 with a connect
 * URL; re-export replaces the tracked document's body; Google's error text
 * is never reflected.
 */
const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/integrations/google-docs", name), "utf8"))

const DOC = fixture("document-created.json")
const ENV = { GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret" } as unknown as NodeJS.ProcessEnv

function docsApi(extra: Parameters<typeof scriptedFetch>[0] = []) {
  return scriptedFetch([
    ...extra,
    on("POST", "/v1/documents/", () => json({ replies: [] })),
    on("POST", "/v1/documents", () => json(DOC)),
    on("GET", "/v1/documents/", () => json(fixture("document-body.json"))),
    on("PATCH", "/drive/v3/files/", () => json({ id: DOC.documentId })),
  ])
}

function runtime(
  options: {
    connection?: IntegrationConnectionDTO | null
    extra?: Parameters<typeof scriptedFetch>[0]
    prefs?: { allowPrivatePush: boolean; allowPrivateSetByUserId?: string }
  } = {}
) {
  const api = docsApi(options.extra)
  const links = memoryLinkStore()
  const lookups: unknown[] = []
  const value = {
    providerFetch: api.fetch,
    findActiveConnection: vi.fn(async (workspaceId: string, provider: string, lookup?: { userId?: string }) => {
      lookups.push({ workspaceId, provider, ...lookup })

      return options.connection === null ? undefined : (options.connection ?? connectionDto("google_drive", { userId: lookup?.userId }))
    }),
    getAccessToken: vi.fn(async () => "user_drive_token"),
    linkStore: () => links,
    getPrefs: vi.fn(async () => options.prefs),
  } as unknown as ManualExportRuntime

  setManualExportRuntime(value)

  return { api, links, lookups }
}

async function callExport(options: Parameters<typeof createTestCtx>[0] & { query?: string; body?: Record<string, unknown>; meetingId?: string } = {}) {
  setRouteCtx(
    await createTestCtx({
      meetings: [
        testMeeting({
          id: "m_he",
          title: "סנכרון שבועי",
          language: "he",
          summary: { overview: "סיכום", decisions: ["החלטה"], actionItems: [] },
          transcript: [{ id: "t1", startMs: 0, endMs: 1000, speaker: "דנה", text: "שלום" }],
        }),
        testMeeting({ id: "m_private", visibility: "private", ownerUserId: "user_me" }),
      ],
      ...options,
    })
  )

  const meetingId = options.meetingId ?? "m_he"

  return exportDocs(
    jsonRequest(`http://localhost/api/meetings/${meetingId}/export/google-docs${options.query ?? ""}`, "POST", options.body ?? {}),
    routeParams({ id: meetingId })
  )
}

beforeEach(() => {
  vi.stubEnv("MEETSUM_RATE_LIMIT", "false")
})

afterEach(() => {
  vi.unstubAllEnvs()
  setRouteCtx(undefined)
  setManualExportRuntime(undefined)
  recordAuditLog.mockReset()
  delegated.mockReset()
})

describe("POST /api/meetings/:id/export/google-docs", () => {
  it("answers 409 with a connect URL when the user has no Drive connection (and no DWD)", async () => {
    runtime({ connection: null })
    const response = await callExport()
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body).toEqual({
      error: "google_docs_not_connected",
      connectUrl: `/api/integrations/google_drive/oauth/start?returnTo=${encodeURIComponent("/he?meeting=m_he")}`,
    })

    setManualExportRuntime(undefined)
    expect((await callExport()).status).toBe(409)
  })

  it("looks up the requester's personal connection and creates the document", async () => {
    const { api, lookups, links } = runtime()
    const response = await callExport({ body: { includeTranscript: true } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      documentId: DOC.documentId,
      url: `https://docs.google.com/document/d/${DOC.documentId}/edit`,
      updated: false,
    })
    expect(lookups).toEqual([{ workspaceId: "ws_a", provider: "google_drive", userId: "user_me" }])
    expect(api.calls.every((call) => call.provider === "google_drive")).toBe(true)
    expect(api.calls.every((call) => call.headers.authorization === "Bearer user_drive_token")).toBe(true)

    const batch = api.calls.find((call) => call.path.endsWith(":batchUpdate"))!
    const requests = (batch.body as { requests: Record<string, unknown>[] }).requests

    expect(Object.keys(requests[0])).toEqual(["insertText"])
    expect(JSON.stringify(requests)).toContain("RIGHT_TO_LEFT")
    expect(JSON.stringify(requests)).toContain("שלום")
    expect(links.rows).toEqual([expect.objectContaining({ objectKind: "google_doc", externalId: DOC.documentId })])
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "meeting.export.google_docs",
        metadata: { documentId: DOC.documentId, updated: false, via: "oauth" },
      })
    )
  })

  it("re-export replaces the tracked document's body; ?new=1 forces a new document", async () => {
    const { api } = runtime()

    await callExport()
    api.calls.length = 0

    const second = await callExport()

    expect(await second.json()).toMatchObject({ documentId: DOC.documentId, updated: true })
    expect(api.calls.some((call) => call.method === "POST" && call.path === "/v1/documents")).toBe(false)

    const batch = api.calls.find((call) => call.path.endsWith(":batchUpdate"))!
    const requests = (batch.body as { requests: Record<string, unknown>[] }).requests

    expect(requests[0]).toEqual({ deleteContentRange: { range: { startIndex: 1, endIndex: 317 } } })
    expect(Object.keys(requests[1])).toEqual(["insertText"])

    api.calls.length = 0
    const fresh = await callExport({ query: "?new=1" })

    expect(await fresh.json()).toMatchObject({ updated: false })
    expect(api.calls.some((call) => call.method === "POST" && call.path === "/v1/documents")).toBe(true)
  })

  it("replaces a tracked document that is gone with a new one", async () => {
    const { links } = runtime({
      extra: [on("GET", "/v1/documents/", () => json(fixture("error-not-found.json"), 404))],
    })

    await links.upsert({ objectKind: "google_doc", destinationKey: "", externalId: "gone_doc" })

    const response = await callExport()

    expect(await response.json()).toMatchObject({ documentId: DOC.documentId, updated: false })
    expect(links.rows[0].externalId).toBe(DOC.documentId)
  })

  it("lets a member export a private meeting they own to their own Drive after their per-meeting opt-in", async () => {
    const { api } = runtime()
    const blocked = await callExport({ meetingId: "m_private" })

    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toEqual({ error: "private_meeting_not_opted_in" })
    expect(api.calls).toEqual([])

    runtime({ prefs: { allowPrivatePush: true, allowPrivateSetByUserId: "user_me" } })
    expect((await callExport({ meetingId: "m_private" })).status).toBe(200)
    expect((await callExport({ meetingId: "m_private", userId: "user_other" })).status).toBe(404)
  })

  it("refuses with 403 manual_send_disabled when the Drive connection disallows manual sends", async () => {
    const { api } = runtime({ connection: connectionDto("google_drive", { userId: "user_me", config: { allowManualSend: false } }) })
    const response = await callExport({})

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "manual_send_disabled" })
    expect(api.calls).toEqual([])
  })

  it("uses DWD only inside the workspace domain (mismatch refused), never the user-oauth strategy", async () => {
    vi.stubEnv("MEETSUM_GOOGLE_DOCS_DWD", "true")
    vi.stubEnv("GOOGLE_WORKSPACE_SUBJECT", "admin@example.com")
    delegated.mockResolvedValue({ getAccessToken: async () => ({ token: "dwd_token" }) })
    const { api } = runtime({ connection: null })

    // The test workspace is not the default one, so it has no subject yet.
    const noSubject = await callExport({ email: "me@example.com" })

    expect(noSubject.status).toBe(409)

    setRouteCtx(undefined)
    const ctx = await createTestCtx({ email: "me@example.com", meetings: [testMeeting({ id: "m_he" })] })

    ctx.workspace.googleSubject = "admin@example.com"
    setRouteCtx(ctx)
    const allowed = await exportDocs(
      jsonRequest("http://localhost/api/meetings/m_he/export/google-docs", "POST", {}),
      routeParams({ id: "m_he" })
    )

    expect(allowed.status).toBe(200)
    expect(delegated).toHaveBeenCalledWith("me@example.com", [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive.file",
    ])
    expect(api.calls.every((call) => call.headers.authorization === "Bearer dwd_token")).toBe(true)

    const mismatch = await createTestCtx({ email: "me@other.org", meetings: [testMeeting({ id: "m_he" })] })

    mismatch.workspace.googleSubject = "admin@example.com"
    setRouteCtx(mismatch)
    expect(
      (await exportDocs(jsonRequest("http://localhost/api/meetings/m_he/export/google-docs", "POST", {}), routeParams({ id: "m_he" })))
        .status
    ).toBe(409)

    authStatus.mockReturnValueOnce({ strategy: "user-oauth" })
    setRouteCtx(ctx)
    expect(
      (await exportDocs(jsonRequest("http://localhost/api/meetings/m_he/export/google-docs", "POST", {}), routeParams({ id: "m_he" })))
        .status
    ).toBe(409)
  })

  it("never reflects Google's error text", async () => {
    runtime({ extra: [on("POST", "/v1/documents", () => json(fixture("error-permission.json"), 403))] })
    const response = await callExport()
    const text = await response.text()

    expect(response.status).toBe(403)
    expect(JSON.parse(text)).toEqual({ error: "google_docs_forbidden" })
    expect(text).not.toMatch(/permission|project 123456/i)
  })
})

describe("google_drive OAuth", () => {
  it("authorizes with PKCE S256, drive.file, offline access and consent", () => {
    const url = new URL(
      googleDocsAuthorizeUrl({ state: "st", redirectUri: "https://app.example.com/cb", codeChallenge: "challenge" }, ENV)
    )

    expect(url.origin).toBe("https://accounts.google.com")
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "gid",
      scope: "https://www.googleapis.com/auth/drive.file",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      code_challenge: "challenge",
      code_challenge_method: "S256",
    })
    expect(() => googleDocsAuthorizeUrl({ state: "s", redirectUri: "r" }, ENV)).toThrow()
  })

  it("exchanges the code with the verifier; the account is the Drive user", async () => {
    const { fetch, calls } = scriptedFetch([
      on("POST", "/token", () => json(fixture("token.json"))),
      on("GET", "/drive/v3/about", () => json(fixture("drive-about.json"))),
    ])
    const result = await exchangeGoogleDocsCode("code", { redirectUri: "r", codeVerifier: "verifier" }, { fetch, env: ENV })

    expect(calls[0].body).toMatchObject({
      grant_type: "authorization_code",
      code: "code",
      code_verifier: "verifier",
      client_id: "gid",
    })
    expect(result).toMatchObject({
      accessToken: "ya29.fixture_access_token_google_docs",
      refreshToken: "1//fixture_refresh_token_google_docs",
      scopes: ["https://www.googleapis.com/auth/drive.file"],
      account: { externalId: "07158442151285376045", label: "dana@example.com" },
    })
    expect(calls.every((call) => call.provider === "google_drive")).toBe(true)
  })

  it("maps invalid_grant on refresh to auth (needs reauth)", async () => {
    const { fetch } = scriptedFetch([on("POST", "/token", () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400))])

    await expect(refreshGoogleDocsToken("rt", { fetch, env: ENV })).rejects.toMatchObject({ kind: "auth", message: "google_docs_invalid_grant" })
  })
})
