/**
 * HubSpot meetings/notes and tasks (docs/parity/m8.md, B3 steps 2–3).
 *
 * Association type ids (HUBSPOT_DEFINED). Verified 2026-10-14 (M10 R2)
 * against https://developers.hubspot.com/docs/api-reference/crm-associations-v4/guide:
 * meeting→contact 200, meeting→deal 212, note→contact 202, note→deal 214,
 * task→contact 204, task→deal 216 (pinned by tests/hubspot-docs-verified.test.ts).
 * The v4 associations API goes unsupported on 2027-03-30 and `/crm/v3/objects`
 * after September 2027 (AUDIT follow-up: move to the 2026-09 date paths).
 */
import type { HubspotClient } from "@/lib/integrations/hubspot/client"
import { dueEndOfDayIso, type MeetingRecap, type MeetingRecapActionItem } from "@/lib/integrations/recap"

export const ASSOCIATION_TYPE_IDS = {
  meeting: { contact: 200, deal: 212 },
  note: { contact: 202, deal: 214 },
  task: { contact: 204, deal: 216 },
} as const

export const TASK_BATCH_SIZE = 100

export type EngagementKind = "meeting" | "note"

const OBJECT_PATH: Record<EngagementKind | "task", string> = { meeting: "meetings", note: "notes", task: "tasks" }

type Target = { contactIds: readonly string[]; dealId?: string }

export function associationsFor(kind: EngagementKind | "task", target: Target) {
  const types = ASSOCIATION_TYPE_IDS[kind]
  const one = (id: string, typeId: number) => ({
    to: { id },
    types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }],
  })

  return [
    ...target.contactIds.map((id) => one(id, types.contact)),
    ...(target.dealId ? [one(target.dealId, types.deal)] : []),
  ]
}

function endIso(recap: MeetingRecap): string {
  const start = Date.parse(recap.startedAt)

  return new Date(start + (recap.durationMs ?? 0)).toISOString()
}

export function engagementProperties(kind: EngagementKind, recap: MeetingRecap, html: string): Record<string, string> {
  const startedAt = new Date(recap.startedAt).toISOString()

  if (kind === "note") return { hs_timestamp: startedAt, hs_note_body: html }

  const properties: Record<string, string> = {
    hs_timestamp: startedAt,
    hs_meeting_title: recap.title.slice(0, 500),
    hs_meeting_body: html,
    hs_meeting_start_time: startedAt,
    hs_meeting_end_time: endIso(recap),
    hs_meeting_outcome: "COMPLETED",
  }

  if (recap.links.meeting?.startsWith("https://")) properties.hs_meeting_external_url = recap.links.meeting
  return properties
}

type ObjectResponse = { id?: string }

export async function createEngagement(
  client: HubspotClient,
  kind: EngagementKind,
  properties: Record<string, string>,
  target: Target
): Promise<string> {
  const created = await client.request<ObjectResponse>("POST", `/crm/v3/objects/${OBJECT_PATH[kind]}`, {
    properties,
    associations: associationsFor(kind, target),
  })

  if (!created?.id) throw new Error("hubspot create without id")
  return created.id
}

export async function updateEngagement(
  client: HubspotClient,
  kind: EngagementKind,
  id: string,
  properties: Record<string, string>
): Promise<void> {
  await client.request("PATCH", `/crm/v3/objects/${OBJECT_PATH[kind]}/${encodeURIComponent(id)}`, { properties })
}

/**
 * Idempotent (re-)association after a PATCH, e.g. a new attendee contact:
 * `POST /crm/v4/associations/{from}/{to}/batch/create` (verify the v4 batch
 * shape against current docs).
 */
export async function associate(client: HubspotClient, kind: EngagementKind | "task", id: string, target: Target): Promise<void> {
  const types = ASSOCIATION_TYPE_IDS[kind]
  const groups: Array<{ to: "contacts" | "deals"; ids: readonly string[]; typeId: number }> = [
    { to: "contacts", ids: target.contactIds, typeId: types.contact },
    { to: "deals", ids: target.dealId ? [target.dealId] : [], typeId: types.deal },
  ]

  for (const group of groups) {
    if (!group.ids.length) continue
    await client.request("POST", `/crm/v4/associations/${OBJECT_PATH[kind]}/${group.to}/batch/create`, {
      inputs: group.ids.map((toId) => ({
        from: { id },
        to: { id: toId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: group.typeId }],
      })),
    })
  }
}

const PRIORITY: Record<NonNullable<MeetingRecapActionItem["priority"]>, string> = {
  low: "LOW",
  normal: "MEDIUM",
  high: "HIGH",
  urgent: "HIGH",
}

export function taskProperties(
  item: MeetingRecapActionItem,
  recap: MeetingRecap,
  ownerId: string | undefined
): Record<string, string> {
  // Due at the local end of the due day (MEETSUM_DEFAULT_TIMEZONE); the
  // meeting end only when there is no due date.
  const due = item.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate) ? dueEndOfDayIso(item.dueDate) : endIso(recap)
  const body = [recap.title, recap.links.meeting].filter(Boolean).join("\n")
  const properties: Record<string, string> = {
    hs_task_subject: item.title.slice(0, 500),
    hs_task_body: body,
    hs_timestamp: due,
    hs_task_status: "NOT_STARTED",
    hs_task_type: "TODO",
  }

  // HubSpot documents LOW, MEDIUM and HIGH only (verified 2026-10-14), so
  // no priority means the property is omitted, not "NONE".
  if (item.priority) properties.hs_task_priority = PRIORITY[item.priority]
  if (ownerId) properties.hubspot_owner_id = ownerId
  return properties
}

type BatchResponse = { results?: Array<{ id?: string; objectWriteTraceId?: string }> }

/**
 * `POST /crm/v3/objects/tasks/batch/create`; each input carries
 * `objectWriteTraceId = actionItemId` so results map back to items even if
 * HubSpot reorders them (verify the echo against current docs; falls back to
 * input order). Returns actionItemId → task id.
 */
export async function createTaskBatch(
  client: HubspotClient,
  inputs: Array<{ actionItemId: string; properties: Record<string, string> }>,
  target: Target
): Promise<Map<string, string>> {
  const response = await client.request<BatchResponse>("POST", "/crm/v3/objects/tasks/batch/create", {
    inputs: inputs.map((input) => ({
      objectWriteTraceId: input.actionItemId,
      properties: input.properties,
      associations: associationsFor("task", target),
    })),
  })
  const results = response?.results ?? []
  const byItem = new Map<string, string>()
  const traced = results.length > 0 && results.every((result) => result.objectWriteTraceId)

  // HubSpot does not document that results echo objectWriteTraceId
  // (2026-10-14). Without the echo, index mapping is only safe when every
  // input got a result; otherwise map nothing and let the marker search
  // find the created tasks on retry.
  if (!traced && results.length !== inputs.length) return byItem

  results.forEach((result, index) => {
    const actionItemId = traced ? result.objectWriteTraceId : inputs[index]?.actionItemId

    if (result.id && actionItemId && inputs.some((input) => input.actionItemId === actionItemId)) {
      byItem.set(actionItemId, result.id)
    }
  })

  return byItem
}
