import { describe, expect, it, vi } from "vitest"

import {
  createPostgresCaptureSubscriptionStore,
  ensureTeamsSubscription,
  getTeamsSubscriptionConfig,
  handleTeamsLifecycleNotifications,
  isTeamsSubscriptionConfigured,
  renewTeamsSubscriptions,
  type CaptureSubscriptionRecord,
  type CaptureSubscriptionStore,
  type TeamsSubscriptionConfig,
  type TeamsSubscriptionDeps,
} from "@/lib/capture/teams-subscriptions"

const NOW = new Date("2026-10-12T12:00:00.000Z")
const MINUTE = 60_000

const config: TeamsSubscriptionConfig = {
  resource: "communications/onlineMeetings/getAllRecordings",
  changeType: "created",
  notificationUrl: "https://meetsum.example/api/webhooks/teams",
  lifecycleNotificationUrl: "https://meetsum.example/api/webhooks/teams/lifecycle",
  clientState: "state-secret",
  expirationMinutes: 4200,
  renewBeforeMinutes: 720,
}

function memoryStore(initial: CaptureSubscriptionRecord[] = []) {
  const rows = new Map(initial.map((row) => [row.id, { ...row }]))
  const store: CaptureSubscriptionStore = {
    async listActive(platform) {
      return [...rows.values()].filter(
        (row) => row.platform === platform && row.status === "active"
      )
    },
    async listAll(platform) {
      return [...rows.values()].filter((row) => row.platform === platform)
    },
    async findByExternalId(id) {
      return [...rows.values()].find((row) => row.externalSubscriptionId === id)
    },
    async insert(record) {
      const row = {
        ...record,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      }
      rows.set(row.id, row)
      return row
    },
    async update(id, patch) {
      const row = rows.get(id)
      if (!row) return
      if (patch.expiresAt !== undefined) row.expiresAt = patch.expiresAt
      if (patch.status !== undefined) row.status = patch.status
      if (patch.lastError !== undefined) row.lastError = patch.lastError ?? undefined
    },
  }

  return { store, rows }
}

function record(overrides: Partial<CaptureSubscriptionRecord> = {}): CaptureSubscriptionRecord {
  return {
    id: "capsub_1",
    platform: "teams",
    externalSubscriptionId: "graph-sub-1",
    resource: config.resource,
    changeType: "created",
    notificationUrl: config.notificationUrl,
    lifecycleNotificationUrl: config.lifecycleNotificationUrl,
    expiresAt: new Date(NOW.getTime() + 60 * MINUTE).toISOString(),
    status: "active",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  }
}

function graphMock(
  handler: (method: string, path: string, body: Record<string, unknown>) => Response
) {
  return vi.fn(async (path: string, init: RequestInit = {}) =>
    handler(
      init.method ?? "GET",
      path,
      init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    )
  )
}

function deps(store: CaptureSubscriptionStore, graph: TeamsSubscriptionDeps["graph"]): TeamsSubscriptionDeps {
  let counter = 0
  return { store, graph, config, createId: () => `capsub_new_${++counter}` }
}

describe("teams subscription configuration", () => {
  const env = {
    MEETSUM_STORAGE: "postgres",
    AZURE_TENANT_ID: "t",
    AZURE_CLIENT_ID: "c",
    AZURE_CLIENT_SECRET: "s",
    TEAMS_WEBHOOK_CLIENT_STATE: "state",
    MEETINGS_APP_URL: "https://meetsum.example/",
  } as unknown as NodeJS.ProcessEnv

  it("derives the notification URLs and defaults", () => {
    expect(getTeamsSubscriptionConfig(env)).toEqual({
      resource: "communications/onlineMeetings/getAllRecordings",
      changeType: "created",
      notificationUrl: "https://meetsum.example/api/webhooks/teams",
      lifecycleNotificationUrl: "https://meetsum.example/api/webhooks/teams/lifecycle",
      clientState: "state",
      expirationMinutes: 4200,
      renewBeforeMinutes: 720,
    })
    expect(isTeamsSubscriptionConfigured(env)).toBe(true)
  })

  it("is not configured without https, credentials or postgres", () => {
    expect(
      isTeamsSubscriptionConfigured({ ...env, MEETINGS_APP_URL: "http://127.0.0.1:3000" })
    ).toBe(false)
    expect(isTeamsSubscriptionConfigured({ ...env, AZURE_CLIENT_SECRET: "" })).toBe(false)
    expect(isTeamsSubscriptionConfigured({ ...env, MEETSUM_STORAGE: "memory" })).toBe(false)
    expect(isTeamsSubscriptionConfigured({} as NodeJS.ProcessEnv)).toBe(false)
  })

  it("honours resource and timing overrides", () => {
    expect(
      getTeamsSubscriptionConfig({
        ...env,
        TEAMS_SUBSCRIPTION_RESOURCE: "users/u1/onlineMeetings/getAllRecordings",
        TEAMS_SUBSCRIPTION_EXPIRATION_MINUTES: "60",
        TEAMS_SUBSCRIPTION_RENEW_BEFORE_MINUTES: "15",
      })
    ).toMatchObject({
      resource: "users/u1/onlineMeetings/getAllRecordings",
      expirationMinutes: 60,
      renewBeforeMinutes: 15,
    })
  })
})

describe("ensureTeamsSubscription", () => {
  it("creates a Graph subscription when none exists", async () => {
    const { store, rows } = memoryStore()
    const graph = graphMock((method, path, body) => {
      expect(method).toBe("POST")
      expect(path).toBe("subscriptions")
      expect(body).toMatchObject({
        changeType: "created",
        resource: config.resource,
        notificationUrl: config.notificationUrl,
        lifecycleNotificationUrl: config.lifecycleNotificationUrl,
        clientState: "state-secret",
        expirationDateTime: new Date(NOW.getTime() + 4200 * MINUTE).toISOString(),
      })
      return Response.json({ id: "graph-new", expirationDateTime: body.expirationDateTime })
    })

    const result = await ensureTeamsSubscription(NOW, deps(store, graph))

    expect(result.action).toBe("created")
    expect(result.subscription).toMatchObject({
      externalSubscriptionId: "graph-new",
      status: "active",
    })
    expect(rows.size).toBe(1)
  })

  it("keeps a healthy subscription untouched", async () => {
    const { store } = memoryStore([
      record({ expiresAt: new Date(NOW.getTime() + 3000 * MINUTE).toISOString() }),
    ])
    const graph = graphMock(() => {
      throw new Error("should not call Graph")
    })

    const result = await ensureTeamsSubscription(NOW, deps(store, graph))

    expect(result.action).toBe("existing")
    expect(graph).not.toHaveBeenCalled()
  })

  it("reports a clear error when not configured", async () => {
    await expect(ensureTeamsSubscription(NOW, undefined)).rejects.toMatchObject({
      status: 503,
    })
  })
})

describe("renewTeamsSubscriptions", () => {
  it("renews subscriptions inside the renew-before window", async () => {
    const { store, rows } = memoryStore([record()])
    const graph = graphMock((method, path, body) => {
      expect(method).toBe("PATCH")
      expect(path).toBe("subscriptions/graph-sub-1")
      return Response.json({ id: "graph-sub-1", expirationDateTime: body.expirationDateTime })
    })

    const result = await renewTeamsSubscriptions(NOW, deps(store, graph))

    expect(result).toEqual({ renewed: 1, created: 0, failed: 0 })
    expect(rows.get("capsub_1")?.expiresAt).toBe(
      new Date(NOW.getTime() + 4200 * MINUTE).toISOString()
    )
  })

  it("recreates a subscription Graph no longer knows (404)", async () => {
    const { store, rows } = memoryStore([record()])
    const graph = graphMock((method) =>
      method === "PATCH"
        ? new Response(JSON.stringify({ error: { code: "ResourceNotFound" } }), { status: 404 })
        : Response.json({ id: "graph-recreated" })
    )

    const result = await renewTeamsSubscriptions(NOW, deps(store, graph))

    expect(result).toEqual({ renewed: 0, created: 1, failed: 0 })
    expect(rows.get("capsub_1")?.status).toBe("removed")
    expect(
      [...rows.values()].find((row) => row.externalSubscriptionId === "graph-recreated")
        ?.status
    ).toBe("active")
  })

  it("creates the subscription when none is active", async () => {
    const { store } = memoryStore()
    const graph = graphMock(() => Response.json({ id: "graph-new" }))

    expect(await renewTeamsSubscriptions(NOW, deps(store, graph))).toEqual({
      renewed: 0,
      created: 1,
      failed: 0,
    })
  })

  it("counts failures and records the Graph error", async () => {
    const { store, rows } = memoryStore([record()])
    const graph = graphMock(
      () =>
        new Response(JSON.stringify({ error: { code: "Forbidden", message: "nope" } }), {
          status: 403,
        })
    )

    const result = await renewTeamsSubscriptions(NOW, deps(store, graph))

    expect(result).toEqual({ renewed: 0, created: 0, failed: 1 })
    expect(rows.get("capsub_1")?.lastError).toContain("Forbidden: nope")
    expect(rows.get("capsub_1")?.status).toBe("active")
  })

  it("is a no-op when not configured", async () => {
    expect(await renewTeamsSubscriptions(NOW, undefined)).toEqual({
      renewed: 0,
      created: 0,
      failed: 0,
    })
  })
})

describe("handleTeamsLifecycleNotifications", () => {
  it("renews on reauthorizationRequired, recreates on subscriptionRemoved, records missed", async () => {
    const { store, rows } = memoryStore([
      record(),
      record({ id: "capsub_2", externalSubscriptionId: "graph-sub-2" }),
      record({ id: "capsub_3", externalSubscriptionId: "graph-sub-3" }),
    ])
    const graph = graphMock((method, _path, body) =>
      method === "PATCH"
        ? Response.json({ expirationDateTime: body.expirationDateTime })
        : Response.json({ id: "graph-replacement" })
    )

    const outcomes = await handleTeamsLifecycleNotifications(
      [
        { subscriptionId: "graph-sub-1", lifecycleEvent: "reauthorizationRequired" },
        { subscriptionId: "graph-sub-2", lifecycleEvent: "subscriptionRemoved" },
        { subscriptionId: "graph-sub-3", lifecycleEvent: "missed" },
        { subscriptionId: "unknown", lifecycleEvent: "missed" },
      ],
      NOW,
      deps(store, graph)
    )

    expect(outcomes.map((outcome) => outcome.action)).toEqual([
      "renewed",
      "recreated",
      "recorded",
      "ignored",
    ])
    expect(rows.get("capsub_2")?.status).toBe("removed")
    expect(rows.get("capsub_3")?.lastError).toContain("missed")
    expect(
      [...rows.values()].some((row) => row.externalSubscriptionId === "graph-replacement")
    ).toBe(true)
  })
})

describe("postgres capture subscription store", () => {
  it("maps rows and builds parameterized updates", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select")) {
        return {
          rows: [
            {
              id: "capsub_1",
              platform: "teams",
              external_subscription_id: "graph-sub-1",
              resource: config.resource,
              change_type: "created",
              notification_url: config.notificationUrl,
              lifecycle_notification_url: null,
              expires_at: new Date("2026-10-13T00:00:00Z"),
              status: "active",
              last_error: null,
              created_at: new Date("2026-10-12T00:00:00Z"),
              updated_at: new Date("2026-10-12T00:00:00Z"),
            },
          ],
        }
      }
      return { rows: [] }
    })
    const store = createPostgresCaptureSubscriptionStore({ query })

    const [row] = await store.listActive("teams")
    await store.update("capsub_1", { status: "removed", lastError: null })

    expect(row).toMatchObject({
      externalSubscriptionId: "graph-sub-1",
      lifecycleNotificationUrl: undefined,
      expiresAt: "2026-10-13T00:00:00.000Z",
    })
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("set status = $2, last_error = $3, updated_at = now() where id = $1"),
      ["capsub_1", "removed", null]
    )
  })
})
