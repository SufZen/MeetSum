import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

import { GET as listRules, POST as createRuleRoute } from "@/app/api/integrations/rules/route"
import { DELETE as deleteRuleRoute, PATCH as patchRuleRoute } from "@/app/api/integrations/rules/[id]/route"
import { evaluateRule } from "@/lib/integrations/core/dispatcher"
import { setProviderTransportForTesting } from "@/lib/integrations/core/http"
import { setIntegrationStoreForTesting, type IntegrationStore } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import { sealTokenSet } from "@/lib/integrations/core/tokens"
import type { MeetingFacts } from "@/lib/integrations/core/types"
import { testRule } from "@/lib/integrations/testing/harness"
import { resetRateLimitsForTesting } from "@/lib/rate-limit"
import type { WorkspaceRole } from "@/lib/workspaces/types"

/**
 * M8 Integration step, item 11: re-audit of lib/integrations/core/rules.ts
 * after Package A's fix.
 *  - rule CRUD is admin-only (`integrations:manage`); members have no rule
 *    routes at all;
 *  - another workspace's connection and rule ids are 404;
 *  - `includePrivate` is honoured only for the creator's own private
 *    meetings, only while they remain the owner and a member;
 *  - an API key can neither set `includePrivate` nor keep it with an edit
 *    (the finding fixed here: an API key acting for the rule's creator kept
 *    the opt-in while changing the destination).
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

const BASE = "http://localhost/api"
const DEST = { provider: "slack", channelId: "C1", channelName: "general" }

describe("integration rules authorization (re-audit)", () => {
  let store: IntegrationStore

  async function as(role: WorkspaceRole, options: { userId?: string; workspaceId?: string; apiKeyCreatedBy?: string } = {}) {
    setRouteCtx(
      await createTestCtx({
        role,
        userId: options.userId ?? "user_admin",
        workspaceId: options.workspaceId ?? "ws_a",
        ...(options.apiKeyCreatedBy ? { principal: "api_key" as const, apiKeyCreatedBy: options.apiKeyCreatedBy } : {}),
      })
    )
  }

  async function connection(id: string, workspaceId: string) {
    const created = await store.createConnection({
      id,
      workspaceId,
      provider: "slack",
      status: "active",
      accountLabel: "Acme",
      externalAccountId: `${id}_ext`,
      scopes: [],
      ...sealTokenSet(workspaceId, id, { accessToken: "xoxb-rules-authz", scopes: [] }),
      config: {},
      createdByUserId: "user_admin",
    })

    if (!created.ok) throw new Error("setup")
  }

  const create = (body: Record<string, unknown>) =>
    createRuleRoute(
      jsonRequest(`${BASE}/integrations/rules`, "POST", {
        provider: "slack",
        connectionId: "intc_a",
        name: "r",
        trigger: "meeting.completed",
        destination: DEST,
        ...body,
      }),
      routeParams({})
    )
  const patch = (id: string, body: Record<string, unknown>) => patchRuleRoute(jsonRequest(`${BASE}/x`, "PATCH", body), routeParams({ id }))

  beforeEach(async () => {
    resetRateLimitsForTesting()
    store = createMemoryIntegrationStore()
    setIntegrationStoreForTesting(store)
    setProviderTransportForTesting(async () => Response.json({ ok: true, channel: { is_member: true } }))
    await connection("intc_a", "ws_a")
    await connection("intc_b", "ws_b")
  })

  afterEach(() => {
    setRouteCtx(undefined)
    setIntegrationStoreForTesting(undefined)
    setProviderTransportForTesting(undefined)
  })

  it("keeps rule CRUD admin-only", async () => {
    await store.createRule(testRule({ id: "intr_x", connectionId: "intc_a" }))

    for (const role of ["member", "viewer"] as const) {
      await as(role, { userId: "user_member" })
      expect((await listRules(new Request(`${BASE}/x`), routeParams({}))).status).toBe(403)
      expect((await create({})).status).toBe(403)
      expect((await patch("intr_x", { name: "x" })).status).toBe(403)
      expect((await deleteRuleRoute(new Request(`${BASE}/x`, { method: "DELETE" }), routeParams({ id: "intr_x" }))).status).toBe(403)
    }
  })

  it("answers 404 for another workspace's connection or rule id", async () => {
    await store.createRule(testRule({ id: "intr_b", workspaceId: "ws_b", connectionId: "intc_b", createdByUserId: "user_b" }))
    await as("admin")

    expect((await create({ connectionId: "intc_b" })).status).toBe(404)
    expect((await patch("intr_b", { name: "x" })).status).toBe(404)
    expect((await patch("intr_b", { destination: DEST })).status).toBe(404)
    expect((await deleteRuleRoute(new Request(`${BASE}/x`, { method: "DELETE" }), routeParams({ id: "intr_b" }))).status).toBe(404)
    expect((await store.getRule("ws_b", "intr_b"))?.name).toBe("Rule")
  })

  it("never lets an API key set includePrivate", async () => {
    await as("admin", { apiKeyCreatedBy: "user_admin" })

    const response = await create({ includePrivate: true })

    expect(response.status).toBe(201)
    expect((await response.json()).rule).toMatchObject({ includePrivate: false, createdByUserId: "user_admin" })
  })

  it("clears the creator's opt-in when an API key edits their rule (finding fixed)", async () => {
    await store.createRule(testRule({ id: "intr_own", connectionId: "intc_a", includePrivate: true, createdByUserId: "user_admin" }))
    await as("admin", { apiKeyCreatedBy: "user_admin" })

    const response = await patch("intr_own", { destination: { ...DEST, channelId: "C2" } })

    expect(response.status).toBe(200)
    expect((await response.json()).rule).toMatchObject({ includePrivate: false })
    expect((await store.getRule("ws_a", "intr_own"))?.includePrivate).toBe(false)

    // Not even when the key asks to keep it.
    await store.updateRule("ws_a", "intr_own", { includePrivate: true })
    await patch("intr_own", { includePrivate: true })
    expect((await store.getRule("ws_a", "intr_own"))?.includePrivate).toBe(false)
  })

  it("keeps the opt-in for the creator's own edit, and clears it for another admin's edit", async () => {
    await store.createRule(testRule({ id: "intr_own", connectionId: "intc_a", includePrivate: true, createdByUserId: "user_admin" }))

    await as("admin", { userId: "user_admin" })
    expect((await (await patch("intr_own", { name: "renamed" })).json()).rule).toMatchObject({ includePrivate: true })

    await as("admin", { userId: "user_admin_2" })
    expect((await (await patch("intr_own", { name: "again" })).json()).rule).toMatchObject({
      includePrivate: false,
      createdByUserId: "user_admin_2",
    })
  })

  it("honours another admin's explicit includePrivate:true in the same save (they become the creator)", async () => {
    await store.createRule(testRule({ id: "intr_theirs", connectionId: "intc_a", includePrivate: true, createdByUserId: "user_admin" }))

    await as("admin", { userId: "user_admin_2" })
    const response = await patch("intr_theirs", { name: "mine now", includePrivate: true })

    expect(response.status).toBe(200)
    // The opt-in now covers the EDITOR's own private meetings only (creator = editor).
    expect((await response.json()).rule).toMatchObject({ includePrivate: true, createdByUserId: "user_admin_2" })

    // An API key still always clears it.
    await as("admin", { apiKeyCreatedBy: "user_admin_2" })
    await patch("intr_theirs", { includePrivate: true })
    expect((await store.getRule("ws_a", "intr_theirs"))?.includePrivate).toBe(false)
  })

  it("honours includePrivate only for the creator's own private meetings while they are owner and member", async () => {
    const rule = { ...testRule({ includePrivate: true, createdByUserId: "user_admin" }), createdAt: "", updatedAt: "" }
    const facts = (ownerUserId: string): MeetingFacts => ({
      meetingId: "m",
      workspaceId: "ws_a",
      visibility: "private",
      ownerUserId,
      contextIds: [],
      tagNames: [],
      participantEmails: [],
      language: "he",
      source: "upload",
    })
    const evaluate = (ownerUserId: string, ownerIsMember: boolean) =>
      evaluateRule({ rule, facts: facts(ownerUserId), prefs: undefined, ownerIsMember, internalDomains: [], checkFilters: true })

    expect(evaluate("user_admin", true)).toEqual({ status: "queued" })
    // Someone else's private meeting (or one whose ownership moved away).
    expect(evaluate("user_owner", true)).toEqual({ status: "skipped", reason: "private_meeting" })
    // The creator left the workspace.
    expect(evaluate("user_admin", false)).toEqual({ status: "skipped", reason: "rule_owner_inactive" })
    // An admin's per-meeting "opt-in" for someone else's meeting is ignored.
    expect(
      evaluateRule({
        rule: { ...rule, includePrivate: false },
        facts: facts("user_owner"),
        prefs: { meetingId: "m", workspaceId: "ws_a", allowPrivatePush: true, allowPrivateSetByUserId: "user_admin", emailRecap: "inherit" },
        ownerIsMember: true,
        internalDomains: [],
        checkFilters: true,
      })
    ).toEqual({ status: "skipped", reason: "private_meeting" })
  })
})
