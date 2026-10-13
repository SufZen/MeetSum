import { readFileSync } from "node:fs"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createTestCtx,
  jsonRequest,
  routeParams,
  setRouteCtx,
  testMeeting,
} from "./helpers/route-ctx"
import { connectionDto, deliveryDto, json, memoryLinkStore, on, scriptedFetch } from "./helpers/integration-doubles"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const { recordAuditLog } = vi.hoisted(() => ({ recordAuditLog: vi.fn() }))

vi.mock("@/lib/audit", () => ({ recordAuditLog }))

import { POST as exportNotion } from "@/app/api/meetings/[id]/export/notion/route"
import type { DeliverResult, IntegrationConnectionDTO } from "@/lib/integrations/core/types"
import { setManualExportRuntime, type ManualExportRuntime } from "@/lib/integrations/notion/manual-export-runtime"

/**
 * M8 C1 route: the Notion token comes only from the workspace connection;
 * `meeting:write` + visible, private → canManageMeeting; not connected →
 * 409; Notion's error messages are never reflected; a re-export updates
 * the same page.
 */
const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/integrations/notion", name), "utf8"))

const BASE = "http://localhost"
const DATABASE_ID = "8a1f0c2e-1d6b-4b8e-9b37-1f2d3c4b5a60"
const PAGE = fixture("page-created.json")
const globalFetch = vi.fn()

type Finish = Parameters<ManualExportRuntime["finishManualDelivery"]>[2]

function runtime(options: { connection?: IntegrationConnectionDTO | null; routes?: Parameters<typeof scriptedFetch>[0] } = {}) {
  const api = scriptedFetch(
    options.routes ?? [
      on("GET", `/v1/databases/${DATABASE_ID}`, () => json(fixture("database.json"))),
      on("POST", "/v1/pages", () => json(PAGE)),
      on("PATCH", /^\/v1\/blocks\/[^/]+\/children$/, () => json({ object: "list", results: [] })),
      on("PATCH", "/v1/pages/", () => json(PAGE)),
      on("GET", /^\/v1\/blocks\/[^/]+\/children/, () => json({ object: "list", results: [] })),
    ]
  )
  const links = memoryLinkStore()
  const finished: Finish[] = []
  const tokens: string[] = []
  const deliveries = new Map<string, { status: string; externalRef: Record<string, unknown> }>()
  const value: ManualExportRuntime = {
    providerFetch: api.fetch,
    findActiveConnection: vi.fn(async (_workspaceId, provider) =>
      options.connection === null ? undefined : (options.connection ?? connectionDto(provider, { config: { defaultDatabaseId: DATABASE_ID } }))
    ),
    getAccessToken: vi.fn(async (workspaceId: string, connectionId: string) => {
      tokens.push(`${workspaceId}:${connectionId}`)

      return "connection_access_token"
    }),
    linkStore: () => links,
    startManualDelivery: vi.fn(async (input) => {
      const existing = deliveries.get(input.idempotencyKey)

      if (existing) {
        return { delivery: deliveryDto("notion", { id: "intd_replay", status: existing.status as never, externalRef: existing.externalRef }), replayed: true }
      }
      deliveries.set(input.idempotencyKey, { status: "running", externalRef: {} })

      return { delivery: deliveryDto("notion", { id: `intd_${deliveries.size}` }), replayed: false }
    }),
    saveDeliveryProgress: vi.fn(async () => {}),
    finishManualDelivery: vi.fn(async (_workspaceId, _deliveryId, outcome: Finish) => {
      finished.push(outcome)
      for (const entry of deliveries.values()) {
        if (entry.status === "running" && "result" in outcome) {
          entry.status = "sent"
          entry.externalRef = (outcome.result as DeliverResult).externalRef
        }
      }
    }),
  }

  setManualExportRuntime(value)

  return { value, api, links, finished, tokens }
}

async function callExport(
  body: Record<string, unknown>,
  options: Parameters<typeof createTestCtx>[0] & { headers?: Record<string, string> } = {}
) {
  setRouteCtx(
    await createTestCtx({
      meetings: [
        testMeeting({ id: "m_shared", title: "Shared", visibility: "workspace" }),
        testMeeting({ id: "m_private", title: "Private", visibility: "private", ownerUserId: "user_owner" }),
      ],
      ...options,
    })
  )

  const meetingId = (body.meetingId as string | undefined) ?? "m_shared"
  const request = jsonRequest(`${BASE}/api/meetings/${meetingId}/export/notion`, "POST", body)

  for (const [name, value] of Object.entries(options.headers ?? {})) request.headers.set(name, value)

  return exportNotion(request, routeParams({ id: meetingId }))
}

beforeEach(() => {
  globalFetch.mockReset()
  vi.stubGlobal("fetch", globalFetch)
  vi.stubEnv("NOTION_TOKEN", "secret_operator_token")
  vi.stubEnv("MEETSUM_RATE_LIMIT", "false")
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  setRouteCtx(undefined)
  setManualExportRuntime(undefined)
  recordAuditLog.mockReset()
})

describe("POST /api/meetings/:id/export/notion", () => {
  it("rejects viewers (needs meeting:write)", async () => {
    runtime()
    const response = await callExport({ databaseId: DATABASE_ID }, { role: "viewer" })

    expect(response.status).toBe(403)
  })

  it("refuses a body token (never uses it, nor NOTION_TOKEN)", async () => {
    const { api } = runtime()
    const response = await callExport({ databaseId: DATABASE_ID, token: "secret_user" })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "token_not_accepted" })
    expect(api.calls).toHaveLength(0)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("answers 404 for an invisible meeting and 403 for a private meeting the member does not own", async () => {
    runtime()

    expect((await callExport({ meetingId: "m_missing" })).status).toBe(404)

    // Another member: the private meeting is invisible → 404 (no existence leak).
    expect((await callExport({ meetingId: "m_private" })).status).toBe(404)

    // Visible but not manageable (an editor who can see it through a share is not the owner).
    const response = await callExport(
      { meetingId: "m_private" },
      {
        meetings: [
          testMeeting({
            id: "m_private",
            visibility: "private",
            ownerUserId: "user_owner",
            participantDetails: [
              {
                id: "p1",
                meetingId: "m_private",
                name: "Me",
                email: "me@example.com",
                role: "attendee",
                source: "calendar",
                attendanceStatus: "accepted",
                createdAt: "",
                updatedAt: "",
              },
            ],
          }),
        ],
      }
    )

    expect([403, 404]).toContain(response.status)
  })

  it("lets the owner export a private meeting", async () => {
    runtime()
    const response = await callExport({ meetingId: "m_private" }, { userId: "user_owner" })

    expect(response.status).toBe(200)
  })

  it("answers 409 notion_not_connected without a connection or runtime", async () => {
    runtime({ connection: null })
    expect((await callExport({})).status).toBe(409)
    expect(await (await callExport({})).json()).toEqual({ error: "notion_not_connected" })

    setManualExportRuntime(undefined)
    expect((await callExport({})).status).toBe(409)
  })

  it("exports with the connection token and the default database, then updates the same page", async () => {
    const { api, tokens, links } = runtime()
    const first = await callExport({}, { role: "member", headers: { "idempotency-key": "11111111-aaaa-4bbb-8ccc-000000000001" } })
    const firstBody = await first.json()

    expect(first.status).toBe(200)
    expect(firstBody).toEqual({ deliveryId: "intd_1", pageId: PAGE.id, url: PAGE.url, updated: false })
    expect(tokens).toEqual(["ws_a:intc_1"])
    expect(api.calls.every((call) => call.headers.authorization === "Bearer connection_access_token")).toBe(true)
    expect(api.calls.every((call) => !JSON.stringify(call).includes("secret_operator_token"))).toBe(true)
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "meeting.export.notion",
        workspaceId: "ws_a",
        metadata: { deliveryId: "intd_1", connectionId: "intc_1", provider: "notion", updated: false },
      })
    )

    const second = await callExport({ databaseId: DATABASE_ID }, { headers: { "idempotency-key": "11111111-aaaa-4bbb-8ccc-000000000002" } })

    expect(await second.json()).toMatchObject({ pageId: PAGE.id, updated: true })
    expect(api.calls.filter((call) => call.method === "POST" && call.path === "/v1/pages")).toHaveLength(1)
    expect(links.rows).toHaveLength(1)
  })

  it("replays a repeated Idempotency-Key without calling Notion again", async () => {
    const { api } = runtime()
    const headers = { "idempotency-key": "22222222-aaaa-4bbb-8ccc-000000000001" }

    await callExport({}, { headers })
    const before = api.calls.length
    const replay = await callExport({}, { headers })

    expect(await replay.json()).toMatchObject({ deliveryId: "intd_replay", pageId: PAGE.id })
    expect(api.calls.length).toBe(before)
  })

  it("never reflects Notion's error message", async () => {
    const { finished } = runtime({
      routes: [on("GET", `/v1/databases/${DATABASE_ID}`, () => json(fixture("error-object-not-found.json"), 404))],
    })
    const response = await callExport({})
    const text = await response.text()

    expect(response.status).toBe(404)
    expect(JSON.parse(text)).toEqual({ error: "notion_not_found" })
    expect(text).not.toMatch(/Could not find|secret_internal_detail|object_not_found/)
    expect(JSON.stringify(finished)).not.toMatch(/Could not find|secret_internal_detail/)
  })

  it("passes Retry-After on a rate limit", async () => {
    runtime({
      routes: [on("GET", `/v1/databases/${DATABASE_ID}`, () => json(fixture("error-rate-limited.json"), 429, { "retry-after": "20" }))],
    })
    const response = await callExport({})

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("20")
    expect(await response.json()).toEqual({ error: "notion_rate_limited" })
  })

  it("asks for a database when none is given or configured", async () => {
    runtime({ connection: connectionDto("notion") })
    const response = await callExport({})

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "notion_database_required" })
  })
})
