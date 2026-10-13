import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { IntegrationStore, NewConnection, NewRule } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import { createPostgresIntegrationStore } from "@/lib/integrations/core/store-postgres"
import { DEFAULT_RULE_CONTENT } from "@/lib/integrations/recap"
import { createMigratedPglite, seedIntegrationFixtures, type TestPg } from "@/lib/integrations/testing/pglite"

/**
 * M8 store contract, run on the memory store and on Postgres (PGlite with
 * migrations 001–027): workspace scoping (W2 ids are not found), the
 * connection and rule caps, rule → connection same-workspace check, the
 * email-rule singleton, delivery idempotency keys, delivery claim, links,
 * prefs, unsubscribes and the single-use OAuth state.
 */

let pg: TestPg | undefined
let pgError: unknown

beforeAll(async () => {
  const created = await createMigratedPglite()

  pg = created.db
  pgError = created.error
  if (pg) await seedIntegrationFixtures(pg)
}, 180_000)

afterAll(async () => {
  await pg?.close()
})

let counter = 0
const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(counter += 1)}`

function connection(overrides: Partial<NewConnection> = {}): NewConnection {
  return {
    id: uid("intc"),
    workspaceId: "ws_a",
    provider: "slack",
    status: "active",
    accountLabel: "Team",
    externalAccountId: uid("T"),
    scopes: ["chat:write"],
    accessTokenEnc: "v2:enc",
    config: {},
    ...overrides,
  }
}

function rule(overrides: Partial<NewRule> = {}): NewRule {
  return {
    id: uid("intr"),
    workspaceId: "ws_a",
    provider: "slack",
    connectionId: null,
    name: "Rule",
    enabled: true,
    trigger: "meeting.completed",
    filters: {},
    destination: { provider: "slack", channelId: "C1", channelName: "general" },
    content: DEFAULT_RULE_CONTENT,
    includePrivate: false,
    createdByUserId: "user_admin",
    ...overrides,
  }
}

const backends: [string, () => IntegrationStore | undefined][] = [
  ["memory", () => createMemoryIntegrationStore()],
  ["postgres", () => (pg ? createPostgresIntegrationStore(pg) : undefined)],
]

describe.each(backends)("IntegrationStore (%s)", (name, make) => {
  function storeOrSkip(context: { skip: (note?: string) => void }): IntegrationStore {
    const store = make()

    if (!store) context.skip(`PGlite did not load: ${String(pgError)}`)
    return store as IntegrationStore
  }

  async function freshWorkspace(store: IntegrationStore): Promise<string> {
    if (store.kind === "memory") return "ws_a"

    const id = uid("ws")

    await (pg as TestPg).query("insert into workspaces (id, name, slug) values ($1, $1, $1)", [id])
    return id
  }

  it("scopes connections to their workspace and keeps tokens only on the stored row", async (context) => {
    const store = storeOrSkip(context)
    const created = await store.createConnection(connection())

    expect(created.ok).toBe(true)
    const id = created.ok ? created.connection.id : ""

    expect((await store.getConnection("ws_a", id))?.accessTokenEnc).toBe("v2:enc")
    expect(await store.getConnection("ws_b", id)).toBeUndefined()
    expect(await store.updateConnection("ws_b", id, { status: "revoked" })).toBeUndefined()
    expect((await store.listConnections("ws_b")).map((row) => row.id)).not.toContain(id)

    const cleared = await store.updateConnection("ws_a", id, { accessTokenEnc: null, status: "revoked", revokedAt: new Date().toISOString() })

    expect(cleared?.accessTokenEnc).toBeUndefined()
    expect(cleared?.status).toBe("revoked")
    expect((await store.listConnections("ws_a")).map((row) => row.id)).not.toContain(id)
    expect((await store.listConnections("ws_a", { includeRevoked: true })).map((row) => row.id)).toContain(id)
  })

  it("finds the reconnect target by account key and caps connections at 20", async (context) => {
    const store = storeOrSkip(context)
    const ws = await freshWorkspace(store)
    const first = connection({ workspaceId: ws, externalAccountId: "T_same" })

    await store.createConnection(first)
    expect((await store.findConnectionByAccount(ws, "slack", undefined, "T_same"))?.id).toBe(first.id)
    expect(await store.findConnectionByAccount("ws_b", "slack", undefined, "T_same")).toBeUndefined()

    const existing = (await store.listConnections(ws)).length

    for (let index = existing; index < 20; index += 1) {
      expect((await store.createConnection(connection({ workspaceId: ws }))).ok).toBe(true)
    }
    expect(await store.createConnection(connection({ workspaceId: ws }))).toEqual({ ok: false, reason: "cap" })
  })

  it("only lets a rule reference an active, same-workspace, same-provider connection", async (context) => {
    const store = storeOrSkip(context)
    const created = await store.createConnection(connection())
    const connectionId = created.ok ? created.connection.id : ""

    expect((await store.createRule(rule({ connectionId }))).ok).toBe(true)
    expect(await store.createRule(rule({ workspaceId: "ws_b", connectionId }))).toEqual({
      ok: false,
      reason: "connection_not_found",
    })
    expect(
      await store.createRule(
        rule({ connectionId, provider: "notion", destination: { provider: "notion", databaseId: "d", databaseTitle: "D" } })
      )
    ).toEqual({ ok: false, reason: "connection_not_found" })

    await store.updateConnection("ws_a", connectionId, { status: "needs_reauth" })
    expect((await store.createRule(rule({ connectionId }))).ok).toBe(false)
  })

  it("caps rules at 50 per workspace", async (context) => {
    const store = storeOrSkip(context)
    const ws = await freshWorkspace(store)
    const created = await store.createConnection(connection({ workspaceId: ws }))
    const connectionId = created.ok ? created.connection.id : ""
    const existing = (await store.listRules(ws)).length

    for (let index = existing; index < 50; index += 1) {
      expect((await store.createRule(rule({ workspaceId: ws, connectionId }))).ok).toBe(true)
    }
    expect(await store.createRule(rule({ workspaceId: ws, connectionId }))).toEqual({ ok: false, reason: "cap" })
    expect((await store.listEnabledRulesForEvent(ws, "meeting.completed", 500)).length).toBe(50)
  })

  it("keeps one email rule per workspace (upsert)", async (context) => {
    const store = storeOrSkip(context)
    const ws = await freshWorkspace(store)
    const email = (mode: "all_meetings" | "opt_in") =>
      rule({
        workspaceId: ws,
        provider: "email",
        connectionId: null,
        destination: { provider: "email", audience: "members", mode, locale: "meeting" },
      })
    const first = await store.createRule(email("all_meetings"))
    const second = await store.createRule(email("opt_in"))

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.rule.id).toBe(first.rule.id)
    expect(second.rule.destination).toMatchObject({ mode: "opt_in" })
    expect((await store.listRules(ws)).filter((row) => row.provider === "email")).toHaveLength(1)
  })

  it("disables a connection's rules and cancels its queued deliveries", async (context) => {
    const store = storeOrSkip(context)
    const created = await store.createConnection(connection())
    const connectionId = created.ok ? created.connection.id : ""
    const made = await store.createRule(rule({ connectionId }))
    const ruleId = made.ok ? made.rule.id : ""
    const queued = await store.insertDelivery({
      id: uid("intd"),
      workspaceId: "ws_a",
      ruleId,
      connectionId,
      provider: "slack",
      origin: "rule",
      meetingId: "m_a",
      idempotencyKey: uid("key"),
      status: "queued",
      maxAttempts: 5,
    })

    expect(await store.disableRulesForConnection("ws_b", connectionId, "connection_revoked")).toEqual([])
    expect(await store.disableRulesForConnection("ws_a", connectionId, "connection_revoked")).toEqual([ruleId])
    expect(await store.getRule("ws_a", ruleId)).toMatchObject({ enabled: false, disabledReason: "connection_revoked" })
    expect(await store.cancelQueuedDeliveriesForConnection("ws_a", connectionId)).toEqual([queued.delivery.id])
    expect((await store.getDelivery("ws_a", queued.delivery.id))?.status).toBe("cancelled")
  })

  it("dedupes deliveries on (workspace, idempotency key) and claims only live rows", async (context) => {
    const store = storeOrSkip(context)
    const key = uid("rule:x:meeting.completed")
    const base = {
      workspaceId: "ws_a",
      provider: "email" as const,
      origin: "rule" as const,
      meetingId: "m_a",
      idempotencyKey: key,
      status: "queued" as const,
      maxAttempts: 5,
    }
    const first = await store.insertDelivery({ ...base, id: uid("intd") })
    const again = await store.insertDelivery({ ...base, id: uid("intd") })
    const otherWorkspace = await store.insertDelivery({ ...base, id: uid("intd"), workspaceId: "ws_b", meetingId: "m_b" })

    expect(first.created).toBe(true)
    expect(again).toMatchObject({ created: false, delivery: { id: first.delivery.id } })
    expect(otherWorkspace.created).toBe(true)
    expect(await store.getDelivery("ws_b", first.delivery.id)).toBeUndefined()
    expect(await store.claimDelivery("ws_b", first.delivery.id)).toBeUndefined()

    const claimed = await store.claimDelivery("ws_a", first.delivery.id)

    expect(claimed).toMatchObject({ status: "running", attempts: 1 })
    await store.updateDelivery("ws_a", first.delivery.id, {
      status: "sent",
      completedAt: new Date().toISOString(),
      progress: { sentLog: [{ at: new Date().toISOString(), n: 3 }] },
    })
    expect(await store.claimDelivery("ws_a", first.delivery.id)).toBeUndefined()
    expect(await store.countRecapEmailsSince("ws_a", new Date(Date.now() - 60_000))).toBeGreaterThanOrEqual(3)
    expect(await store.countRecapEmailsSince("ws_b", new Date(Date.now() - 60_000))).toBe(0)

    const listed = await store.listDeliveries("ws_a", { provider: "email", limit: 200 })

    expect(listed.map((row) => row.id)).toContain(first.delivery.id)
    expect(listed.every((row) => row.workspaceId === "ws_a")).toBe(true)

    const page = await store.listDeliveries("ws_a", { limit: 1 })
    const next = await store.listDeliveries("ws_a", { limit: 1, before: `${page[0].createdAt}|${page[0].id}` })

    expect(next[0]?.id).not.toBe(page[0].id)
  })

  it("stores links per connection/meeting/key and never across workspaces", async (context) => {
    const store = storeOrSkip(context)
    const created = await store.createConnection(connection())
    const connectionId = created.ok ? created.connection.id : ""
    const scope = { workspaceId: "ws_a", connectionId, meetingId: "m_a" }
    const first = await store.upsertLink({ ...scope, provider: "slack" }, { objectKind: "slack_message", destinationKey: "C1", externalId: "1.0" })
    const updated = await store.upsertLink(
      { ...scope, provider: "slack" },
      { objectKind: "slack_message", destinationKey: "C1", externalId: "2.0", contentHash: "h" }
    )

    expect(updated.id).toBe(first.id)
    expect(await store.getLink(scope, { objectKind: "slack_message", destinationKey: "C1" })).toMatchObject({
      externalId: "2.0",
      contentHash: "h",
    })
    expect(await store.getLink({ ...scope, workspaceId: "ws_b" }, { objectKind: "slack_message", destinationKey: "C1" })).toBeUndefined()
    expect(await store.listLinks(scope, "slack_message")).toHaveLength(1)
    await store.removeLink({ ...scope, workspaceId: "ws_b" }, { objectKind: "slack_message", destinationKey: "C1" })
    expect(await store.listLinks(scope, "slack_message")).toHaveLength(1)
    await store.removeLink(scope, { objectKind: "slack_message", destinationKey: "C1" })
    expect(await store.listLinks(scope, "slack_message")).toHaveLength(0)
  })

  it("upserts meeting prefs and unsubscribes per workspace", async (context) => {
    const store = storeOrSkip(context)

    expect(await store.getPrefs("ws_a", "m_a")).toBeUndefined()
    await store.upsertPrefs("ws_a", "m_a", { allowPrivatePush: true, allowPrivateSetByUserId: "user_owner", updatedByUserId: "user_owner" })
    await store.upsertPrefs("ws_a", "m_a", { emailRecap: "on" })
    expect(await store.getPrefs("ws_a", "m_a")).toMatchObject({
      allowPrivatePush: true,
      allowPrivateSetByUserId: "user_owner",
      emailRecap: "on",
    })
    expect(await store.getPrefs("ws_b", "m_a")).toBeUndefined()
    await expect(store.upsertPrefs("ws_b", "m_a", { emailRecap: "off" })).rejects.toThrow()

    await store.addUnsubscribe("ws_a", "Dana@Example.com", "link")
    await store.addUnsubscribe("ws_a", "dana@example.com", "one_click")
    expect([...(await store.listUnsubscribed("ws_a", ["DANA@example.com", "avi@example.com"]))]).toEqual(["dana@example.com"])
    expect((await store.listUnsubscribed("ws_b", ["dana@example.com"])).size).toBe(0)
  })

  it("consumes an OAuth state once and never after expiry", async (context) => {
    const store = storeOrSkip(context)
    const nonce = uid("nonce")
    const expired = uid("nonce")

    await store.createOAuthState({
      nonce,
      workspaceId: "ws_a",
      userId: "user_admin",
      provider: "slack",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })
    await store.createOAuthState({
      nonce: expired,
      workspaceId: "ws_a",
      userId: "user_admin",
      provider: "slack",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })

    expect(await store.consumeOAuthState(nonce)).toMatchObject({ nonce, workspaceId: "ws_a", userId: "user_admin" })
    expect(await store.consumeOAuthState(nonce)).toBeUndefined()
    expect(await store.consumeOAuthState(expired)).toBeUndefined()
    expect(await store.systemDeleteExpiredOAuthStates()).toBeGreaterThanOrEqual(1)
  })

  it(`runs refresh work under a connection lock (${name})`, async (context) => {
    const store = storeOrSkip(context)
    const created = await store.createConnection(connection())
    const id = created.ok ? created.connection.id : ""
    const result = await store.withConnectionLock("ws_a", id, async (row, update) => {
      expect(row?.id).toBe(id)
      return update({ accessTokenEnc: "v2:new", lastRefreshedAt: new Date().toISOString() })
    })

    expect(result?.accessTokenEnc).toBe("v2:new")
    expect(await store.withConnectionLock("ws_b", id, async (row) => row)).toBeUndefined()
  })
})
