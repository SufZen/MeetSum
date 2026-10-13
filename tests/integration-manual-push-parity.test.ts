import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

import { POST as exportNotion } from "@/app/api/meetings/[id]/export/notion/route"
import { POST as sendRoute } from "@/app/api/meetings/[id]/integrations/send/route"
import { setProviderTransportForTesting } from "@/lib/integrations/core/http"
import { setIntegrationQueuePortForTesting } from "@/lib/integrations/core/queue"
import { setIntegrationStoreForTesting, type IntegrationStore } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import { sealTokenSet } from "@/lib/integrations/core/tokens"
import { createRecordingQueue, type RecordedJob } from "@/lib/integrations/testing/harness"
import { createInMemoryMeetingDatabase } from "@/lib/meetings/repository"
import { resetRateLimitsForTesting } from "@/lib/rate-limit"

/**
 * Security-review follow-up: the Notion export and POST /integrations/send
 * run the same manual-push checks (`checkManualPush`), so they answer the
 * same way for a connection with manual sends disabled, a forged or
 * malformed Notion database id, and a private meeting without the owner's
 * opt-in, and neither writes to Notion in those cases.
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

const GOOD_DB = "aaaaaaaa-0000-4000-8000-000000000001"
const FORGED_DB = "ffffffff-0000-4000-8000-0000000000ff"

describe("manual push parity: Notion export vs integrations/send", () => {
  let store: IntegrationStore
  let jobs: RecordedJob[]
  let notionCalls: string[]

  beforeEach(async () => {
    resetRateLimitsForTesting()
    vi.stubEnv("MEETSUM_RATE_LIMIT", "false")
    store = createMemoryIntegrationStore()
    jobs = []
    notionCalls = []
    setIntegrationStoreForTesting(store)
    setIntegrationQueuePortForTesting(createRecordingQueue(jobs))
    setProviderTransportForTesting(async (url, init) => {
      const path = new URL(url).pathname

      notionCalls.push(`${init.method ?? "GET"} ${path}`)
      if (path === `/v1/databases/${GOOD_DB}`) return Response.json({ object: "database", id: GOOD_DB, title: [], properties: { Name: { type: "title" } } })
      return Response.json({ object: "error", status: 404, code: "object_not_found", message: "Could not find database" }, { status: 404 })
    })

    const created = await store.createConnection({
      id: "intc_notion",
      workspaceId: "ws_a",
      provider: "notion",
      status: "active",
      accountLabel: "Notion",
      externalAccountId: "nw",
      scopes: [],
      ...sealTokenSet("ws_a", "intc_notion", { accessToken: "secret_parityToken", scopes: [] }),
      config: { defaultDatabaseId: GOOD_DB },
      createdByUserId: "user_admin",
    })

    if (!created.ok) throw new Error("setup")
    setRouteCtx(
      await createTestCtx({
        role: "member",
        userId: "user_owner",
        database: createInMemoryMeetingDatabase([
          testMeeting({ id: "m_shared", visibility: "workspace" }),
          testMeeting({ id: "m_private", visibility: "private", ownerUserId: "user_owner" }),
        ]),
      })
    )
  })

  afterEach(() => {
    setRouteCtx(undefined)
    setIntegrationStoreForTesting(undefined)
    setIntegrationQueuePortForTesting(undefined)
    setProviderTransportForTesting(undefined)
    vi.unstubAllEnvs()
  })

  async function both(meetingId: string, databaseId?: string) {
    const send = await sendRoute(
      jsonRequest("http://localhost/x", "POST", {
        connectionId: "intc_notion",
        ...(databaseId ? { destination: { provider: "notion", databaseId, databaseTitle: "" } } : {}),
      }),
      routeParams({ id: meetingId })
    )
    const exported = await exportNotion(jsonRequest("http://localhost/x", "POST", databaseId ? { databaseId } : {}), routeParams({ id: meetingId }))

    return {
      send: { status: send.status, error: ((await send.json()) as { error?: string }).error },
      export: { status: exported.status, error: ((await exported.json()) as { error?: string }).error },
    }
  }

  const writes = () => notionCalls.filter((call) => !call.startsWith("GET /v1/databases/"))

  it("refuses a connection with manual sends disabled the same way", async () => {
    await store.updateConnection("ws_a", "intc_notion", { config: { defaultDatabaseId: GOOD_DB, allowManualSend: false } })

    const result = await both("m_shared")

    expect(result.send).toEqual({ status: 403, error: "manual_send_disabled" })
    expect(result.export).toEqual(result.send)
    expect(notionCalls).toEqual([])
    expect(jobs).toEqual([])
  })

  it("refuses a forged database id (checked with Notion) and a malformed one the same way", async () => {
    const forged = await both("m_shared", FORGED_DB)

    expect(forged.send).toEqual({ status: 400, error: "invalid_destination" })
    expect(forged.export).toEqual(forged.send)

    const malformed = await both("m_shared", "../v1/users/me")

    expect(malformed.send).toEqual({ status: 400, error: "invalid_destination" })
    expect(malformed.export).toEqual(malformed.send)
    expect(writes()).toEqual([])
    expect(jobs).toEqual([])
  })

  it("refuses a private meeting without the owner's opt-in the same way, and allows both with it", async () => {
    const refused = await both("m_private")

    expect(refused.send).toEqual({ status: 403, error: "private_meeting_not_opted_in" })
    expect(refused.export).toEqual(refused.send)
    expect(notionCalls).toEqual([])

    await store.upsertPrefs("ws_a", "m_private", { allowPrivatePush: true, allowPrivateSetByUserId: "user_owner" })

    const send = await sendRoute(jsonRequest("http://localhost/x", "POST", { connectionId: "intc_notion" }), routeParams({ id: "m_private" }))

    expect(send.status).toBe(202)
    expect(jobs).toHaveLength(1)
  })
})
