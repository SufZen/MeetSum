import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  type DeliverInput,
  type IntegrationLink,
  type IntegrationLinkKey,
  type LinkStore,
  ProviderError,
  type RuleDestination,
} from "@/lib/integrations/core/types"
import { crmCandidateEmails } from "@/lib/integrations/hubspot/contacts"
import { ASSOCIATION_TYPE_IDS } from "@/lib/integrations/hubspot/engagements"
import {
  HUBSPOT_SCOPES,
  exchangeHubspotCode,
  hubspotAuthorizeUrl,
  refreshHubspotToken,
  revokeHubspotToken,
} from "@/lib/integrations/hubspot/oauth"
import {
  configureHubspotProvider,
  deliverToHubspot,
  hubspotProvider,
  resetHubspotProviderForTests,
} from "@/lib/integrations/hubspot/provider"
import { DEFAULT_RULE_CONTENT, buildMeetingRecap } from "@/lib/integrations/recap"
import type { MeetingRecord } from "@/lib/meetings/repository"

import { type FakeRoute, type RecordedCall, createFakeFetch, fixture, json } from "./helpers/provider-fake-fetch"

const API = "https://api.hubapi.com"
const ENV = { HUBSPOT_CLIENT_ID: "hs-client", HUBSPOT_CLIENT_SECRET: "hs-secret" } as unknown as NodeJS.ProcessEnv
const NOW = () => new Date("2026-10-13T12:00:00.000Z")

function memoryLinks(): LinkStore & { rows: IntegrationLink[] } {
  const rows: IntegrationLink[] = []
  const match = (row: IntegrationLink, key: IntegrationLinkKey) =>
    row.objectKind === key.objectKind &&
    row.destinationKey === (key.destinationKey ?? "") &&
    row.actionItemId === (key.actionItemId ?? "")

  return {
    rows,
    async get(key) {
      return rows.find((row) => match(row, key))
    },
    async list(objectKind, destinationKey) {
      return rows.filter((row) => row.objectKind === objectKind && (destinationKey === undefined || row.destinationKey === destinationKey))
    },
    async upsert(key) {
      const existing = rows.find((row) => match(row, key))

      if (existing) {
        Object.assign(existing, { externalId: key.externalId, contentHash: key.contentHash, updatedAt: NOW().toISOString() })
        return existing
      }

      const row: IntegrationLink = {
        id: `intl_${rows.length + 1}`,
        connectionId: "intc_hs",
        provider: "hubspot",
        meetingId: "meet_1",
        objectKind: key.objectKind,
        destinationKey: key.destinationKey ?? "",
        actionItemId: key.actionItemId ?? "",
        externalId: key.externalId,
        externalUrl: key.externalUrl,
        contentHash: key.contentHash,
        createdAt: NOW().toISOString(),
        updatedAt: NOW().toISOString(),
      }

      rows.push(row)
      return row
    },
    async remove(key) {
      const index = rows.findIndex((row) => match(row, key))

      if (index >= 0) rows.splice(index, 1)
    },
  }
}

function meeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "meet_1",
    title: "פגישת סטטוס עם לקוח",
    source: "google_meet",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-10-13T09:00:00.000Z",
    durationMs: 45 * 60_000,
    participants: [],
    visibility: "workspace",
    ownerUserId: "usr_dana",
    participantDetails: [
      { id: "p1", meetingId: "meet_1", name: "Dana", email: "dana@acme.co.il", role: "organizer", source: "calendar", attendanceStatus: "accepted", createdAt: "" },
      { id: "p2", meetingId: "meet_1", name: "CEO", email: "ceo@client.example", role: "attendee", source: "calendar", attendanceStatus: "accepted", createdAt: "" },
      { id: "p3", meetingId: "meet_1", name: "CFO", email: "cfo@client.example", role: "attendee", source: "calendar", attendanceStatus: "accepted", createdAt: "" },
    ],
    summary: {
      overview: "סיכמנו את לוח הזמנים <script>alert(1)</script>",
      actionItems: [
        { id: "ai_1", title: "לשלוח הצעת מחיר", status: "open", ownerParticipantId: "p1", dueOn: "2026-10-20", priority: "high" },
        { id: "ai_2", title: "Book follow-up", status: "open", ownerUserId: "usr_yossi" },
        { id: "ai_3", title: "Done already", status: "done" },
      ],
      decisions: ["להתקדם לפיילוט"],
    },
    ...overrides,
  } as unknown as MeetingRecord
}

const DESTINATION: RuleDestination = {
  provider: "hubspot",
  dealId: "9001",
  dealName: "חידוש חוזה",
  logAs: "meeting",
  createTasks: true,
  createMissingContacts: false,
  matchInternal: false,
}

function harness(options: { routes: FakeRoute[]; meeting?: MeetingRecord; destination?: RuleDestination; links?: ReturnType<typeof memoryLinks>; progress?: Record<string, unknown>; eventName?: string; actionItemId?: string }) {
  const { fetch, calls } = createFakeFetch(options.routes)
  const record = options.meeting ?? meeting()
  const links = options.links ?? memoryLinks()
  const saved: Array<Record<string, unknown>> = []
  const input: DeliverInput = {
    workspaceId: "ws_1",
    delivery: {
      id: "intd_1",
      provider: "hubspot",
      origin: "rule",
      eventName: options.eventName ?? "meeting.completed",
      meetingId: "meet_1",
      actionItemId: options.actionItemId,
      status: "running",
      attempts: 1,
      maxAttempts: 5,
      externalRef: {},
      createdAt: "",
      updatedAt: "",
    },
    getAccessToken: async () => "fixture-hs-access-token-AAA",
    destination: options.destination ?? DESTINATION,
    content: DEFAULT_RULE_CONTENT,
    recap: buildMeetingRecap(record, { content: DEFAULT_RULE_CONTENT, links: { meeting: "https://meetsum.example/he?meeting=meet_1" } }),
    meeting: record,
    progress: options.progress ?? {},
    saveProgress: async (progress) => {
      saved.push(progress)
    },
    links,
    fetch,
  }

  return { input, calls, links, saved }
}

const ROUTES: FakeRoute[] = [
  { match: `POST ${API}/crm/v3/objects/contacts/search`, respond: json(fixture("hubspot/contacts-search.json")) },
  { match: `POST ${API}/crm/v3/objects/meetings`, respond: json(fixture("hubspot/meeting-create.json"), 201) },
  { match: `GET ${API}/crm/v3/owners`, respond: (call) => (call.url.includes("dana%40acme.co.il") ? { body: fixture("hubspot/owners.json") } : { body: { results: [] } }) },
  { match: `POST ${API}/crm/v3/objects/tasks/batch/create`, respond: json(fixture("hubspot/tasks-batch.json"), 201) },
  { match: `PATCH ${API}/crm/v3/objects/meetings/88001`, respond: json({ id: "88001" }) },
  { match: `POST ${API}/crm/v4/associations/meetings/`, respond: json({ status: "COMPLETE", results: [] }) },
]

const byPath = (calls: RecordedCall[], fragment: string) => calls.filter((call) => call.url.includes(fragment))

beforeEach(() => {
  configureHubspotProvider({
    env: ENV,
    now: NOW,
    internalDomains: async () => ["acme.co.il"],
    memberEmails: async () => new Map([["usr_yossi", "yossi@acme.co.il"]]),
    privacyGate: undefined,
  })
})

afterEach(() => {
  resetHubspotProviderForTests()
})

describe("hubspot oauth", () => {
  it("builds the authorize URL with required + optional scopes and no PKCE", () => {
    const url = new URL(hubspotAuthorizeUrl({ state: "st", redirectUri: "https://app/cb" }, ENV))

    expect(url.origin + url.pathname).toBe("https://app.hubspot.com/oauth/authorize")
    expect(url.searchParams.get("scope")).toBe(HUBSPOT_SCOPES.join(" "))
    expect(url.searchParams.get("optional_scope")).toBe("crm.objects.owners.read")
    expect(url.searchParams.get("code_challenge")).toBeNull()
    expect(hubspotProvider.oauth?.pkce).toBe(false)
    expect(hubspotProvider.configured(ENV)).toBe(true)
    expect(hubspotProvider.configured({} as never)).toBe(false)
  })

  it("exchanges the code and labels the account by hub id/domain", async () => {
    const { fetch, calls } = createFakeFetch([
      { match: `POST ${API}/oauth/v1/token`, respond: json(fixture("hubspot/token.json")) },
      { match: `GET ${API}/oauth/v1/access-tokens/`, respond: json(fixture("hubspot/access-token-info.json")) },
    ])
    const result = await exchangeHubspotCode("code-1", { redirectUri: "https://app/cb" }, { fetch, env: ENV, now: NOW })

    expect(result.account).toEqual({ externalId: "24242424", label: "acme-crm.hubspot.com" })
    expect(result.expiresAt).toBe("2026-10-13T12:30:00.000Z")
    expect(result.refreshToken).toBe("fixture-hs-refresh-token-RRR")
    expect(result.scopes).toContain("crm.objects.owners.read")
    expect(calls[0]?.body).toMatchObject({ grant_type: "authorization_code", code: "code-1", client_id: "hs-client" })
    expect(calls.every((call) => call.provider === "hubspot")).toBe(true)
  })

  it("expired token → refresh; a dead refresh token → auth (needs_reauth)", async () => {
    const ok = createFakeFetch([{ match: `POST ${API}/oauth/v1/token`, respond: json(fixture("hubspot/token.json")) }])

    await expect(refreshHubspotToken("r", { fetch: ok.fetch, env: ENV, now: NOW })).resolves.toMatchObject({ accessToken: "fixture-hs-access-token-AAA" })
    expect(ok.calls[0]?.body).toMatchObject({ grant_type: "refresh_token", refresh_token: "r" })

    const bad = createFakeFetch([{ match: `POST ${API}/oauth/v1/token`, respond: json(fixture("hubspot/refresh-bad.json"), 400) }])
    const error = await refreshHubspotToken("r", { fetch: bad.fetch, env: ENV }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ kind: "auth" })
    expect((error as Error).message).not.toContain("unknown refresh token")
  })

  it("revokes the refresh token, tolerating 404", async () => {
    const { fetch, calls } = createFakeFetch([{ match: `DELETE ${API}/oauth/v1/refresh-tokens/`, respond: json(undefined, 404) }])

    await revokeHubspotToken({ accessToken: "a", refreshToken: "fixture-hs-refresh-token-RRR", scopes: [] }, { fetch, env: ENV })
    expect(calls[0]?.url).toBe(`${API}/oauth/v1/refresh-tokens/fixture-hs-refresh-token-RRR`)
  })
})

describe("crmCandidateEmails", () => {
  it("lowercases, de-dupes, drops invalid and internal unless matchInternal", () => {
    const emails = ["CEO@client.example", "ceo@client.example", "dana@acme.co.il", "not-an-email", undefined]

    expect(crmCandidateEmails(emails, { internalDomains: ["acme.co.il"], matchInternal: false })).toEqual(["ceo@client.example"])
    expect(crmCandidateEmails(emails, { internalDomains: ["acme.co.il"], matchInternal: true })).toEqual([
      "ceo@client.example",
      "dana@acme.co.il",
    ])
  })
})

describe("hubspot deliver", () => {
  it("matches contacts, logs the meeting with associations, and creates tasks with owners mapped by email", async () => {
    const h = harness({ routes: ROUTES })
    const result = await deliverToHubspot(h.input)

    const search = byPath(h.calls, "/contacts/search")[0]

    expect(search?.body).toMatchObject({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "IN", values: ["ceo@client.example", "cfo@client.example"] }] }],
    })

    const created = byPath(h.calls, "/crm/v3/objects/meetings")[0]
    const body = created?.body as { properties: Record<string, string>; associations: unknown[] }

    expect(body.properties).toMatchObject({
      hs_timestamp: "2026-10-13T09:00:00.000Z",
      hs_meeting_title: "פגישת סטטוס עם לקוח",
      hs_meeting_start_time: "2026-10-13T09:00:00.000Z",
      hs_meeting_end_time: "2026-10-13T09:45:00.000Z",
      hs_meeting_outcome: "COMPLETED",
    })
    expect(body.properties.hs_meeting_body).toContain('dir="rtl"')
    expect(body.properties.hs_meeting_body).not.toContain("<script>")
    expect(body.properties.hs_meeting_body).toContain("https://meetsum.example/he?meeting=meet_1")
    expect(body.associations).toEqual([
      { to: { id: "501" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOCIATION_TYPE_IDS.meeting.contact }] },
      { to: { id: "502" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 200 }] },
      { to: { id: "9001" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 212 }] },
    ])

    const batch = byPath(h.calls, "/tasks/batch/create")[0]?.body as {
      inputs: Array<{ objectWriteTraceId: string; properties: Record<string, string>; associations: Array<{ types: Array<{ associationTypeId: number }> }> }>
    }

    expect(batch.inputs.map((input) => input.objectWriteTraceId)).toEqual(["ai_1", "ai_2"])
    expect(batch.inputs[0]?.properties).toMatchObject({
      hs_task_subject: "לשלוח הצעת מחיר",
      hs_task_status: "NOT_STARTED",
      hs_task_priority: "HIGH",
      hs_timestamp: "2026-10-20T09:00:00.000Z",
      hubspot_owner_id: "31337",
    })
    expect(batch.inputs[1]?.properties.hubspot_owner_id).toBeUndefined()
    expect(batch.inputs[0]?.associations.map((association) => association.types[0]?.associationTypeId)).toEqual([204, 204, 216])
    // ai_2's owner (usr_yossi) was looked up by member email and was unmatched → unassigned.
    expect(byPath(h.calls, "/crm/v3/owners").map((call) => decodeURIComponent(call.url))).toEqual([
      expect.stringContaining("email=dana@acme.co.il"),
      expect.stringContaining("email=yossi@acme.co.il"),
    ])

    expect(result).toEqual({
      status: "sent",
      // HubSpot reordered the batch results; objectWriteTraceId still maps each task to its item.
      externalRef: { engagementId: "88001", engagementType: "meeting", taskIds: ["77002", "77001"] },
      progress: { contactIds: ["501", "502"], engagementId: "88001", taskIdsByActionItem: { ai_1: "77001", ai_2: "77002" } },
    })
    expect(h.links.rows.map((row) => [row.objectKind, row.destinationKey, row.actionItemId, row.externalId])).toEqual([
      ["hubspot_engagement", "meeting:9001", "", "88001"],
      ["hubspot_task", "9001", "ai_2", "77002"],
      ["hubspot_task", "9001", "ai_1", "77001"],
    ])
    expect(JSON.stringify(result)).not.toContain("לשלוח")
    expect(h.calls.every((call) => call.headers.authorization === "Bearer fixture-hs-access-token-AAA")).toBe(true)
  })

  it("re-send PATCHes the tracked engagement and creates tasks only for new action items", async () => {
    const first = harness({ routes: ROUTES })

    await deliverToHubspot(first.input)

    const updated = meeting({
      summary: {
        ...(meeting().summary as NonNullable<MeetingRecord["summary"]>),
        overview: "עדכון לסיכום",
        actionItems: [
          ...((meeting().summary as NonNullable<MeetingRecord["summary"]>).actionItems ?? []),
          { id: "ai_4", title: "New item", status: "open" },
        ],
      } as NonNullable<MeetingRecord["summary"]>,
    })
    const second = harness({
      routes: [
        ...ROUTES.filter((route) => !route.match.includes("batch/create")),
        { match: `POST ${API}/crm/v3/objects/tasks/batch/create`, respond: json({ results: [{ id: "77004", objectWriteTraceId: "ai_4" }] }, 201) },
      ],
      meeting: updated,
      links: first.links,
    })
    const result = await deliverToHubspot(second.input)

    expect(byPath(second.calls, "/crm/v3/objects/meetings").map((call) => call.method)).toEqual(["PATCH"])
    expect(byPath(second.calls, "/crm/v4/associations/meetings/contacts/batch/create")).toHaveLength(1)
    expect((byPath(second.calls, "/tasks/batch/create")[0]?.body as { inputs: unknown[] }).inputs).toHaveLength(1)
    expect(result.externalRef).toMatchObject({ engagementId: "88001" })
    expect(first.links.rows.filter((row) => row.objectKind === "hubspot_engagement")).toHaveLength(1)

    // An identical third send changes nothing.
    const third = harness({ routes: ROUTES, meeting: updated, links: first.links })

    await deliverToHubspot(third.input)
    expect(third.calls.filter((call) => call.method !== "GET" && !call.url.includes("/search"))).toEqual([])
  })

  it("resumes after a task-batch 500 without re-logging the meeting", async () => {
    const failing = harness({
      routes: [
        ...ROUTES.filter((route) => !route.match.includes("batch/create")),
        { match: `POST ${API}/crm/v3/objects/tasks/batch/create`, respond: json({ status: "error", category: "INTERNAL_ERROR" }, 500) },
      ],
    })
    const error = await deliverToHubspot(failing.input).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({ kind: "retryable" })

    const progress = failing.saved.at(-1) as Record<string, unknown>

    expect(progress).toEqual({ contactIds: ["501", "502"], engagementId: "88001" })

    const retry = harness({ routes: ROUTES, links: failing.links, progress })
    const result = await deliverToHubspot(retry.input)

    expect(byPath(retry.calls, "/contacts/search")).toHaveLength(0)
    expect(byPath(retry.calls, "/crm/v3/objects/meetings")).toHaveLength(0)
    expect(byPath(retry.calls, "/tasks/batch/create")).toHaveLength(1)
    expect(result.status).toBe("sent")
  })

  it("maps 429 to rate_limited with Retry-After", async () => {
    const h = harness({
      routes: [{ match: `POST ${API}/crm/v3/objects/contacts/search`, respond: json(fixture("hubspot/error-429.json"), 429, { "retry-after": "7" }) }],
    })

    await expect(deliverToHubspot(h.input)).rejects.toMatchObject({ kind: "rate_limited", retryAfterMs: 7000, providerCode: "RATE_LIMITS" })
  })

  it("maps a 401 (token rejected even after A's refresh) to auth → needs_reauth, never reflecting the body", async () => {
    const h = harness({
      routes: [{ match: `POST ${API}/crm/v3/objects/contacts/search`, respond: json(fixture("hubspot/error-401.json"), 401) }],
    })
    const error = await deliverToHubspot(h.input).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ kind: "auth", providerCode: "INVALID_AUTHENTICATION" })
    expect((error as Error).message).toBe("hubspot 401")
  })

  it("batches contact search by 100", async () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
      id: `px${index}`,
      meetingId: "meet_1",
      name: `P${index}`,
      email: `p${index}@client.example`,
      role: "attendee",
      source: "calendar",
      attendanceStatus: "accepted",
      createdAt: "",
    }))
    const h = harness({
      routes: [{ match: `POST ${API}/crm/v3/objects/contacts/search`, respond: json({ results: [] }) }],
      meeting: meeting({ participantDetails: many as MeetingRecord["participantDetails"] }),
      destination: { ...DESTINATION, dealId: undefined },
    })
    const result = await deliverToHubspot(h.input)

    expect(byPath(h.calls, "/contacts/search").map((call) => (call.body as { filterGroups: Array<{ filters: Array<{ values: string[] }> }> }).filterGroups[0]?.filters[0]?.values.length)).toEqual([100, 50])
    expect(result).toMatchObject({ status: "skipped", skipReason: "no_crm_target" })
  })

  it("action_item.created creates a single task, then skips it on re-send", async () => {
    const routes: FakeRoute[] = [
      ...ROUTES.filter((route) => !route.match.includes("batch/create")),
      { match: `POST ${API}/crm/v3/objects/tasks/batch/create`, respond: json({ results: [{ id: "77009", objectWriteTraceId: "ai_2" }] }, 201) },
    ]
    const h = harness({ routes, eventName: "action_item.created", actionItemId: "ai_2" })
    const result = await deliverToHubspot(h.input)

    expect(result).toMatchObject({ status: "sent", externalRef: { taskIds: ["77009"] } })
    expect(byPath(h.calls, "/crm/v3/objects/meetings")).toHaveLength(0)

    const again = harness({ routes, eventName: "action_item.created", actionItemId: "ai_2", links: h.links })

    await deliverToHubspot(again.input)
    expect(byPath(again.calls, "/tasks/batch/create")).toHaveLength(0)

    const noTarget = harness({
      routes: [{ match: `POST ${API}/crm/v3/objects/contacts/search`, respond: json({ results: [] }) }],
      eventName: "action_item.created",
      actionItemId: "ai_2",
      destination: { ...DESTINATION, dealId: undefined },
    })

    await expect(deliverToHubspot(noTarget.input)).resolves.toMatchObject({ status: "skipped", skipReason: "no_crm_target" })
  })

  it("logs a note with note association ids when logAs = note", async () => {
    const h = harness({
      routes: [...ROUTES, { match: `POST ${API}/crm/v3/objects/notes`, respond: json({ id: "66001" }, 201) }],
      destination: { ...DESTINATION, logAs: "note", createTasks: false },
    })
    const result = await deliverToHubspot(h.input)
    const body = byPath(h.calls, "/crm/v3/objects/notes")[0]?.body as { properties: Record<string, string>; associations: Array<{ types: Array<{ associationTypeId: number }> }> }

    expect(Object.keys(body.properties).sort()).toEqual(["hs_note_body", "hs_timestamp"])
    expect(body.associations.map((association) => association.types[0]?.associationTypeId)).toEqual([202, 202, 214])
    expect(result.externalRef).toEqual({ engagementId: "66001", engagementType: "note", taskIds: [] })
  })
})

describe("hubspot privacy", () => {
  it("fails closed for a private meeting when A's gate is not wired: no HubSpot call at all", async () => {
    const h = harness({ routes: ROUTES, meeting: meeting({ visibility: "private" }) })

    await expect(deliverToHubspot(h.input)).resolves.toEqual({ status: "skipped", skipReason: "private_meeting", externalRef: {} })
    expect(h.calls).toEqual([])
  })

  it("defers to A's privacy gate when wired (owner opt-in → delivered; denied → skipped)", async () => {
    configureHubspotProvider({ privacyGate: () => true })

    const allowed = harness({ routes: ROUTES, meeting: meeting({ visibility: "private" }) })

    await expect(deliverToHubspot(allowed.input)).resolves.toMatchObject({ status: "sent" })

    configureHubspotProvider({ privacyGate: async () => false })

    const denied = harness({ routes: ROUTES })

    await expect(deliverToHubspot(denied.input)).resolves.toMatchObject({ status: "skipped", skipReason: "private_meeting" })
    expect(denied.calls).toEqual([])
  })
})

describe("hubspot pickers and destination", () => {
  const ctx = (routes: FakeRoute[]) => {
    const fake = createFakeFetch(routes)

    return {
      fake,
      ctx: {
        workspaceId: "ws_1",
        connection: { id: "intc_hs", provider: "hubspot" as const, status: "active" as const, accountLabel: "x", scopes: [], createdAt: "", config: {} },
        getAccessToken: async () => "fixture-hs-access-token-AAA",
        fetch: fake.fetch,
      },
    }
  }

  it("searches deals with paging", async () => {
    const { fake, ctx: providerCtx } = ctx([{ match: `POST ${API}/crm/v3/objects/deals/search`, respond: json(fixture("hubspot/deals-search.json")) }])
    const page = await hubspotProvider.pickers?.deals?.(providerCtx, { query: "חידוש", cursor: "0" })

    expect(page).toEqual({
      items: [
        { id: "9001", label: "חידוש חוזה 2027", hint: "contractsent" },
        { id: "9002", label: "Pilot", hint: "qualifiedtobuy" },
      ],
      nextCursor: "20",
    })
    expect(fake.calls[0]?.body).toEqual({ query: "חידוש", properties: ["dealname", "dealstage", "amount"], limit: 20, after: "0" })
  })

  it("validates the deal exists", async () => {
    const { ctx: providerCtx } = ctx([{ match: `GET ${API}/crm/v3/objects/deals/404`, respond: json({ category: "OBJECT_NOT_FOUND" }, 404) }])

    await expect(hubspotProvider.validateDestination?.({ ...DESTINATION, dealId: "404" }, providerCtx)).rejects.toMatchObject({
      kind: "invalid",
      providerCode: "deal_not_found",
    })
    await expect(hubspotProvider.validateDestination?.({ ...DESTINATION, dealId: "../x" }, providerCtx)).rejects.toMatchObject({ kind: "invalid" })
  })
})
