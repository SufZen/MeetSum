/**
 * HubSpot provider (docs/parity/m8.md, B3): workspace connection; rule or
 * manual deliveries log the meeting (or a note) with the summary and link,
 * associated to the attendees' contacts and the chosen deal, and create
 * tasks from action items with owners mapped by email.
 *
 * Idempotent: `progress = {contactIds, engagementId, taskIdsByActionItem}`
 * lets a retry skip completed steps; `integration_links` make a re-send
 * PATCH the tracked engagement and create tasks only for action items
 * without a `hubspot_task` link.
 *
 * No duplicate on a lost write: every created object carries an
 * unguessable per-create marker (`MeetSum ref: ms-<random>`) in its body. Before a create, a pending intent (`engagementIntent`,
 * `taskIntents`) is written on its own; right after it, the new id is
 * written (before the link). A retry that finds an intent without an id
 * searches HubSpot (`POST /crm/v3/objects/{type}/search` on `hs_timestamp`,
 * then the marker in the body) and adopts the object only when exactly one
 * matches; otherwise it creates anew and never overwrites a foreign object. (VERIFY the search filter on `hs_timestamp`
 * against current HubSpot docs before the first live run.)
 *
 * Privacy: A's privacy gate runs before `deliver` (dispatch and deliver
 * time). `deliver` calls it again through the injected `privacyGate` (the
 * Integration step wires A's gate with per-meeting prefs); unwired, it
 * still calls A's `evaluatePrivacyGate`, without prefs (fails closed): a
 * private meeting is skipped as `private_meeting` without a HubSpot call.
 */
import { createHash, randomBytes } from "node:crypto"

import { evaluatePrivacyGate } from "@/lib/integrations/core/privacy"
import {
  type DeliverInput,
  type DeliverResult,
  type IntegrationProvider,
  ProviderError,
  type ProviderFetch,
  type RuleDestination,
} from "@/lib/integrations/core/types"
import { type HubspotClient, createHubspotClient } from "@/lib/integrations/hubspot/client"
import { crmCandidateEmails, matchContacts } from "@/lib/integrations/hubspot/contacts"
import {
  type EngagementKind,
  TASK_BATCH_SIZE,
  associate,
  createEngagement,
  createTaskBatch,
  engagementProperties,
  taskProperties,
  updateEngagement,
} from "@/lib/integrations/hubspot/engagements"
import { hubspotFakeHandlers } from "@/lib/integrations/hubspot/fake"
import { renderHubspotNoteHtml } from "@/lib/integrations/hubspot/note-html"
import {
  HUBSPOT_SCOPES,
  exchangeHubspotCode,
  hubspotAuthorizeUrl,
  hubspotEnv,
  hubspotOptionalScopes,
  hubspotTokenInfo,
  refreshHubspotToken,
  revokeHubspotToken,
} from "@/lib/integrations/hubspot/oauth"
import { createOwnerResolver } from "@/lib/integrations/hubspot/owners"
import type { MeetingRecapActionItem } from "@/lib/integrations/recap"

export type HubspotRuntime = {
  fetch: ProviderFetch
  env: NodeJS.ProcessEnv
  now: () => Date
  /** Member domains ∪ bot internal domains (M7 `resolveInternalDomains`). */
  internalDomains(workspaceId: string): Promise<string[]>
  /** userId → email of workspace members (task owner mapping). */
  memberEmails(workspaceId: string): Promise<Map<string, string>>
  /** A's privacy gate (core/privacy.ts); unwired → fail closed for non-public meetings. */
  privacyGate?: (input: DeliverInput) => boolean | Promise<boolean>
}

const unwiredFetch: ProviderFetch = async () => {
  throw new ProviderError("config", "provider http not wired")
}

async function defaultMembers(workspaceId: string) {
  const { getWorkspaceStore } = await import("@/lib/workspaces/store")

  return getWorkspaceStore().listMembers(workspaceId)
}

function defaults(): HubspotRuntime {
  return {
    fetch: unwiredFetch,
    env: process.env,
    now: () => new Date(),
    async internalDomains(workspaceId) {
      const [{ resolveInternalDomains }, { getBotConfig }, { getBotRules }, members] = await Promise.all([
        import("@/lib/bot/rules"),
        import("@/lib/bot/config"),
        import("@/lib/settings/bot-rules"),
        defaultMembers(workspaceId),
      ])

      return resolveInternalDomains(
        members.map((member) => member.user.email.toLowerCase()),
        getBotConfig(),
        await getBotRules(workspaceId)
      )
    },
    async memberEmails(workspaceId) {
      const members = await defaultMembers(workspaceId)

      return new Map(members.map((member) => [member.user.id, member.user.email.toLowerCase()]))
    },
  }
}

let runtime: HubspotRuntime = defaults()

export function configureHubspotProvider(patch: Partial<HubspotRuntime>): void {
  runtime = { ...runtime, ...patch }
}

export function resetHubspotProviderForTests(): void {
  runtime = defaults()
}

type HubspotDestination = Extract<RuleDestination, { provider: "hubspot" }>

export type HubspotProgress = {
  contactIds?: string[]
  engagementId?: string
  taskIdsByActionItem?: Record<string, string>
  /** Pending create of the engagement (written before the HubSpot call). */
  engagementIntent?: { destinationKey: string; marker: string }
  /** Pending task creates: actionItemId → marker. */
  taskIntents?: Record<string, string>
}

const OBJECT_PATH = { meeting: "meetings", note: "notes", task: "tasks" } as const
const BODY_PROPERTY = { meeting: "hs_meeting_body", note: "hs_note_body", task: "hs_task_body" } as const

/** An unguessable per-create marker, stored in the pending intent before the create. */
export function newHubspotMarker(): string {
  return `ms-${randomBytes(12).toString("hex")}`
}

function markerLine(kind: EngagementKind | "task", marker: string): string {
  return kind === "task" ? `\nMeetSum ref: ${marker}` : `<p>MeetSum ref: ${marker}</p>`
}

function withMarker(kind: EngagementKind | "task", properties: Record<string, string>, marker: string): Record<string, string> {
  const key = BODY_PROPERTY[kind]

  return { ...properties, [key]: `${properties[key] ?? ""}${markerLine(kind, marker)}` }
}

/**
 * The object a previous attempt created with `marker`: objects at the same
 * `hs_timestamp` whose body contains the marker.
 */
async function findByMarker(
  client: HubspotClient,
  kind: EngagementKind | "task",
  timestamp: string,
  marker: string
): Promise<string | undefined> {
  const at = Date.parse(timestamp)

  if (!Number.isFinite(at)) return undefined

  const body = BODY_PROPERTY[kind]
  const found = await client.request<{ results?: Array<{ id?: string; properties?: Record<string, string | null> }> }>(
    "POST",
    `/crm/v3/objects/${OBJECT_PATH[kind]}/search`,
    {
      filterGroups: [{ filters: [{ propertyName: "hs_timestamp", operator: "EQ", value: String(at) }] }],
      properties: [body],
      limit: 100,
    }
  )

  const matches = (found?.results ?? []).filter((result) => result.id && (result.properties?.[body] ?? "").includes(marker))

  // Adopt only an unambiguous match; anything else creates anew (never overwrite).
  return matches.length === 1 ? matches[0].id : undefined
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

async function privacyAllowed(input: DeliverInput): Promise<boolean> {
  if (runtime.privacyGate) return runtime.privacyGate(input)

  // Unwired: still A's single gate, without per-meeting prefs (fails closed).
  return evaluatePrivacyGate({
    facts: {
      visibility: input.meeting.visibility,
      ...(input.meeting.ownerUserId ? { ownerUserId: input.meeting.ownerUserId } : {}),
    },
    origin: input.delivery.origin,
    ...(input.rule
      ? {
          rule: {
            includePrivate: input.rule.includePrivate,
            ...(input.rule.createdByUserId ? { createdByUserId: input.rule.createdByUserId } : {}),
          },
        }
      : {}),
  }).allowed
}

/** Owner email: recap → M5 resolved participant → M5 resolved member. */
async function ownerEmailResolver(input: DeliverInput) {
  let members: Map<string, string> | undefined

  return async (item: MeetingRecapActionItem): Promise<string | undefined> => {
    if (item.ownerEmail) return item.ownerEmail

    const source = input.meeting.summary?.actionItems?.find((candidate) => candidate.id === item.id)

    if (source?.ownerParticipantId) {
      const participant = input.meeting.participantDetails?.find((candidate) => candidate.id === source.ownerParticipantId)

      if (participant?.email) return participant.email
    }
    if (source?.ownerUserId) {
      members ??= await runtime.memberEmails(input.workspaceId).catch(() => new Map<string, string>())
      return members.get(source.ownerUserId)
    }
    return undefined
  }
}

function participantEmails(input: DeliverInput): string[] {
  return [
    ...input.recap.participants.map((participant) => participant.email),
    ...(input.meeting.participantDetails ?? []).map((participant) => participant.email),
  ].filter((email): email is string => Boolean(email))
}

function findActionItem(input: DeliverInput, id: string | undefined): MeetingRecapActionItem | undefined {
  if (!id) return undefined

  const fromRecap = input.recap.actionItems.find((item) => item.id === id)

  if (fromRecap) return fromRecap

  const source = input.meeting.summary?.actionItems?.find((item) => item.id === id)

  if (!source) return undefined
  return {
    id: source.id,
    title: source.title,
    status: source.status,
    ...(source.dueOn || source.dueDate ? { dueDate: source.dueOn ?? source.dueDate } : {}),
    ...(source.priority ? { priority: source.priority } : {}),
  }
}

async function createTasks(
  input: DeliverInput,
  client: HubspotClient,
  items: MeetingRecapActionItem[],
  target: { contactIds: string[]; dealId?: string },
  progress: HubspotProgress,
  save: (patch: HubspotProgress) => Promise<void>
): Promise<Record<string, string>> {
  const destinationKey = target.dealId ?? ""
  const taskIds: Record<string, string> = { ...(progress.taskIdsByActionItem ?? {}) }
  const pending: MeetingRecapActionItem[] = []

  for (const item of items) {
    if (taskIds[item.id]) continue

    const link = await input.links.get({ objectKind: "hubspot_task", destinationKey, actionItemId: item.id })

    if (link) taskIds[item.id] = link.externalId
    else pending.push(item)
  }

  const ownerOf = createOwnerResolver(client)
  const ownerEmailOf = await ownerEmailResolver(input)
  const intents = { ...(progress.taskIntents ?? {}) }
  const toCreate: Array<{ item: MeetingRecapActionItem; marker: string; properties: Record<string, string> }> = []

  for (const item of pending) {
    const base = taskProperties(item, input.recap, await ownerOf(await ownerEmailOf(item)))
    const previous = intents[item.id]
    // A pending intent from an earlier attempt: the task may exist already.
    const existing = previous ? await findByMarker(client, "task", base.hs_timestamp ?? "", previous) : undefined

    if (existing) {
      taskIds[item.id] = existing
      await save({ taskIdsByActionItem: { ...taskIds } })
      await input.links.upsert({ objectKind: "hubspot_task", destinationKey, actionItemId: item.id, externalId: existing })
    } else {
      const marker = newHubspotMarker()

      toCreate.push({ item, marker, properties: withMarker("task", base, marker) })
    }
  }

  for (let index = 0; index < toCreate.length; index += TASK_BATCH_SIZE) {
    const batch = toCreate.slice(index, index + TASK_BATCH_SIZE)

    // 1. Intents first (their own write).
    for (const { item, marker } of batch) intents[item.id] = marker
    await save({ taskIntents: { ...intents } })

    // 2. The create.
    const created = await createTaskBatch(
      client,
      batch.map(({ item, properties }) => ({ actionItemId: item.id, properties })),
      target
    )

    for (const [actionItemId, taskId] of created) taskIds[actionItemId] = taskId

    // 3. The ids, separately and before the links.
    await save({ taskIdsByActionItem: { ...taskIds } })
    for (const [actionItemId, taskId] of created) {
      await input.links.upsert({ objectKind: "hubspot_task", destinationKey, actionItemId, externalId: taskId })
    }
  }

  return taskIds
}

async function upsertEngagement(
  input: DeliverInput,
  client: HubspotClient,
  destination: HubspotDestination,
  target: { contactIds: string[]; dealId?: string },
  progress: HubspotProgress,
  save: (patch: HubspotProgress) => Promise<void>
): Promise<string> {
  const kind: EngagementKind = destination.logAs
  const destinationKey = `${kind}:${destination.dealId ?? ""}`
  const properties = engagementProperties(kind, input.recap, renderHubspotNoteHtml(input.recap))
  const contentHash = sha256({ kind, properties, target })
  const link = await input.links.get({ objectKind: "hubspot_engagement", destinationKey })
  const remember = async (id: string) => {
    // The id first (its own write), then the link.
    await save({ engagementId: id })
    await input.links.upsert({ objectKind: "hubspot_engagement", destinationKey, externalId: id, contentHash })
    return id
  }

  if (link) {
    if (link.contentHash === contentHash) {
      await save({ engagementId: link.externalId })
      return link.externalId
    }
    try {
      await updateEngagement(client, kind, link.externalId, properties)
      await associate(client, kind, link.externalId, target)
      return await remember(link.externalId)
    } catch (error) {
      // Deleted in HubSpot: log a new one and move the link.
      if (!(error instanceof ProviderError && error.kind === "not_found")) throw error
    }
  }

  // A pending intent from an earlier attempt: the engagement may exist already.
  const intent = progress.engagementIntent

  if (intent?.destinationKey === destinationKey && intent.marker) {
    const existing = await findByMarker(client, kind, properties.hs_timestamp ?? "", intent.marker)

    if (existing) return remember(existing)
  }

  // 1. Intent first (its own write, with a fresh random marker); 2. the
  // create carrying it; 3. the id, then the link.
  const marker = newHubspotMarker()

  await save({ engagementIntent: { destinationKey, marker } })
  return remember(await createEngagement(client, kind, withMarker(kind, properties, marker), target))
}

export async function deliverToHubspot(input: DeliverInput): Promise<DeliverResult> {
  const destination = input.destination

  if (destination.provider !== "hubspot") throw new ProviderError("invalid", "destination is not hubspot")
  if (!(await privacyAllowed(input))) return { status: "skipped", skipReason: "private_meeting", externalRef: {} }

  const isTaskEvent = input.delivery.eventName === "action_item.created"
  const singleItem = isTaskEvent ? findActionItem(input, input.delivery.actionItemId) : undefined

  if (isTaskEvent && (!singleItem || singleItem.status !== "open")) {
    return { status: "skipped", skipReason: "filtered", externalRef: {} }
  }

  let progress: HubspotProgress = { ...(input.progress as HubspotProgress) }
  const save = async (patch: HubspotProgress) => {
    progress = { ...progress, ...patch }
    await input.saveProgress(progress)
  }
  const client = createHubspotClient(input.fetch, await input.getAccessToken())

  if (!progress.contactIds) {
    const emails = crmCandidateEmails(participantEmails(input), {
      internalDomains: destination.matchInternal ? [] : await runtime.internalDomains(input.workspaceId),
      matchInternal: destination.matchInternal,
    })
    const matched = await matchContacts(client, emails, { createMissing: destination.createMissingContacts })

    await save({ contactIds: [...new Set(matched.values())] })
  }

  const target = { contactIds: progress.contactIds ?? [], ...(destination.dealId ? { dealId: destination.dealId } : {}) }

  if (!target.contactIds.length && !target.dealId) {
    return { status: "skipped", skipReason: "no_crm_target", externalRef: {}, progress }
  }

  if (isTaskEvent) {
    const taskIds = await createTasks(input, client, [singleItem as MeetingRecapActionItem], target, progress, save)

    return { status: "sent", externalRef: { taskIds: Object.values(taskIds) }, progress }
  }

  if (!progress.engagementId) await upsertEngagement(input, client, destination, target, progress, save)

  const taskIds = destination.createTasks
    ? await createTasks(
        input,
        client,
        input.recap.actionItems.filter((item) => item.status === "open"),
        target,
        progress,
        save
      )
    : {}

  return {
    status: "sent",
    externalRef: { engagementId: progress.engagementId, engagementType: destination.logAs, taskIds: Object.values(taskIds) },
    progress,
  }
}

type DealSearch = {
  results?: Array<{ id: string; properties?: { dealname?: string | null; dealstage?: string | null; amount?: string | null } }>
  paging?: { next?: { after?: string } }
}

export const hubspotProvider: IntegrationProvider = {
  id: "hubspot",
  scope: "workspace",
  configured: (env = runtime.env) => hubspotEnv(env) !== undefined,
  oauth: {
    pkce: false,
    scopes: [...HUBSPOT_SCOPES],
    get optionalScopes() {
      return hubspotOptionalScopes(runtime.env)
    },
    authorizeUrl: (params) => hubspotAuthorizeUrl(params, runtime.env),
    exchangeCode: (code, params) => exchangeHubspotCode(code, params, runtime),
    refresh: (refreshToken) => refreshHubspotToken(refreshToken, runtime),
    revoke: (tokens) => revokeHubspotToken(tokens, runtime),
  },
  async test(ctx) {
    await hubspotTokenInfo(ctx.fetch, await ctx.getAccessToken(), runtime.env)
  },
  pickers: {
    async deals(ctx, query) {
      const client = createHubspotClient(ctx.fetch, await ctx.getAccessToken())
      const text = query.query?.trim().slice(0, 100)
      const after = query.cursor && /^\d{1,12}$/.test(query.cursor) ? query.cursor : undefined
      const response = await client.request<DealSearch>("POST", "/crm/v3/objects/deals/search", {
        ...(text ? { query: text } : {}),
        properties: ["dealname", "dealstage", "amount"],
        limit: 20,
        ...(after ? { after } : {}),
      })

      return {
        items: (response.results ?? []).map((deal) => ({
          id: deal.id,
          label: deal.properties?.dealname?.trim() || deal.id,
          ...(deal.properties?.dealstage ? { hint: deal.properties.dealstage } : {}),
        })),
        ...(response.paging?.next?.after ? { nextCursor: response.paging.next.after } : {}),
      }
    },
  },
  async validateDestination(destination, ctx) {
    if (destination.provider !== "hubspot") throw new ProviderError("invalid", "destination is not hubspot")
    if (!destination.dealId) return
    if (!/^\d{1,20}$/.test(destination.dealId)) throw new ProviderError("invalid", "hubspot deal id invalid")

    const client = createHubspotClient(ctx.fetch, await ctx.getAccessToken())

    try {
      await client.request("GET", `/crm/v3/objects/deals/${destination.dealId}?properties=dealname`)
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "not_found") {
        throw new ProviderError("invalid", "hubspot deal not found", { providerCode: "deal_not_found" })
      }
      throw error
    }
  },
  deliver: deliverToHubspot,
  fake: hubspotFakeHandlers,
}
