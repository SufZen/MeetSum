/**
 * Webhook event catalog: schemas, examples and descriptions for every event
 * and payload version (docs/parity/m8.md, C4). Owner: Package C.
 *
 * - v1 is today's payloads, frozen for existing subscribers.
 * - v2 is the catalog version: `{id, name, version: 2, occurredAt,
 *   workspace_id, data}` with richer, visibility-aware data.
 * - For a private meeting (or unknown visibility) the data is minimal in both
 *   versions: ids plus `workspace_id` and `visibility: "private"`.
 *
 * `scripts/generate-webhook-schemas.ts` writes the v2 JSON Schemas from
 * here to docs/webhooks/schemas/v2 (a test keeps them in sync).
 */
import { z } from "zod"

import {
  WEBHOOK_EVENTS_V1,
  WEBHOOK_EVENTS_V2,
  type WebhookEventV2,
  type WebhookPayloadVersion,
} from "@/lib/platform/event-catalog"

/**
 * Keys a private-meeting payload may keep: identifiers and job bookkeeping,
 * never titles, text, owners or errors. A superset of the processor's
 * `PRIVATE_EVENT_FIELDS`, extended with the v2 ids.
 */
export const PRIVATE_PAYLOAD_KEYS = [
  "meetingId",
  "actionItemId",
  "clipId",
  "suggestionId",
  "jobId",
  "jobName",
  "attempts",
  "permanent",
  "mode",
] as const

/** Events whose payload depends on the meeting's visibility. */
export const MEETING_SCOPED_EVENTS: readonly WebhookEventV2[] = [
  "meeting.completed",
  "summary.created",
  "action_item.created",
  "action_item.updated",
  "clip.created",
  "meeting.process_failed",
  "realizeos.export.sent",
  "realizeos.export.failed",
]

const id = z.string().min(1)
const isoDate = z.string().min(1).describe("ISO 8601 timestamp")
const visibility = z.enum(["workspace", "link"]).describe("Meeting visibility (private meetings get the minimal payload)")
const priority = z.enum(["low", "normal", "high", "urgent"])

/** The minimal private-meeting payload of an event. */
function privateData(keys: readonly (typeof PRIVATE_PAYLOAD_KEYS)[number][]) {
  const shape: Record<string, z.ZodType> = {}

  for (const key of keys) {
    shape[key] =
      key === "attempts"
        ? z.number().int().optional()
        : key === "permanent"
          ? z.boolean().optional()
          : z.string().optional()
  }

  return z
    .object({ ...shape, workspace_id: id, visibility: z.literal("private") })
    .strict()
    .describe("Private meeting: identifiers only")
}

const meetingCompletedV1 = z.object({ meetingId: id, title: z.string(), mode: z.string().optional() })
const summaryCreatedV1 = z.object({
  meetingId: id,
  title: z.string(),
  mode: z.string().optional(),
  tags: z.array(z.string()).optional(),
})
const actionItemCreatedV1 = z.object({
  meetingId: id,
  actionItemId: id,
  title: z.string(),
  owner: z.string().optional(),
  priority: priority.optional(),
})
const processFailedV1 = z.object({
  meetingId: id,
  jobId: z.string().optional(),
  jobName: z.string().optional(),
  error: z.string().optional(),
  attempts: z.number().int().optional(),
  permanent: z.boolean().optional(),
})
const realizeSentV1 = z.object({
  meetingId: id,
  suggestionId: z.string().optional(),
  responseStatus: z.number().int(),
})
const realizeFailedV1 = realizeSentV1.extend({ error: z.string() })

const DATA_V1 = {
  "meeting.completed": z.union([meetingCompletedV1, privateData(["meetingId", "mode"])]),
  "summary.created": z.union([summaryCreatedV1, privateData(["meetingId", "mode"])]),
  "action_item.created": z.union([actionItemCreatedV1, privateData(["meetingId", "actionItemId"])]),
  "meeting.process_failed": z.union([
    processFailedV1,
    privateData(["meetingId", "jobId", "jobName", "attempts", "permanent"]),
  ]),
  "realizeos.export.sent": z.union([realizeSentV1, privateData(["meetingId", "suggestionId"])]),
  "realizeos.export.failed": z.union([realizeFailedV1, privateData(["meetingId", "suggestionId"])]),
} satisfies Record<(typeof WEBHOOK_EVENTS_V1)[number], z.ZodType>

const DATA_V2 = {
  "meeting.completed": z.union([
    z
      .object({
        meetingId: id,
        title: z.string(),
        mode: z.string().optional(),
        startedAt: isoDate,
        durationMs: z.number().int().nonnegative().optional(),
        language: z.string(),
        participantCount: z.number().int().nonnegative(),
        actionItemCount: z.number().int().nonnegative(),
        overview: z.string().optional(),
        url: z.string(),
        visibility,
      })
      .strict(),
    privateData(["meetingId", "mode"]),
  ]),
  "summary.created": z.union([
    summaryCreatedV1.extend({ url: z.string(), visibility }).strict(),
    privateData(["meetingId", "mode"]),
  ]),
  "action_item.created": z.union([
    actionItemCreatedV1.extend({ url: z.string(), visibility }).strict(),
    privateData(["meetingId", "actionItemId"]),
  ]),
  "meeting.process_failed": z.union([
    processFailedV1.extend({ visibility }).strict(),
    privateData(["meetingId", "jobId", "jobName", "attempts", "permanent"]),
  ]),
  "realizeos.export.sent": z.union([
    realizeSentV1.extend({ visibility }).strict(),
    privateData(["meetingId", "suggestionId"]),
  ]),
  "realizeos.export.failed": z.union([
    realizeFailedV1.extend({ visibility }).strict(),
    privateData(["meetingId", "suggestionId"]),
  ]),
  "action_item.updated": z.union([
    z
      .object({
        meetingId: id,
        actionItemId: id,
        changed: z.array(z.string()),
        title: z.string(),
        owner: z.string().optional(),
        status: z.enum(["open", "done"]),
        dueDate: z.string().optional(),
        priority: priority.optional(),
        url: z.string(),
        visibility,
      })
      .strict(),
    privateData(["meetingId", "actionItemId"]),
  ]),
  "clip.created": z.union([
    z
      .object({
        meetingId: id,
        clipId: id,
        title: z.string().optional(),
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().nonnegative(),
        url: z.string(),
        visibility,
      })
      .strict(),
    privateData(["meetingId", "clipId"]),
  ]),
  "bot.status_changed": z
    .object({
      sessionId: id,
      meetingId: z.string().optional(),
      status: z.string(),
      reason: z.string().optional(),
    })
    .strict()
    .describe("Never carries meeting data beyond its id"),
  "integration.delivery.failed": z
    .object({
      deliveryId: id,
      provider: z.string(),
      meetingId: z.string().optional(),
      reason: z.string(),
    })
    .strict()
    .describe("No content: ids, provider and a reason code"),
} satisfies Record<WebhookEventV2, z.ZodType>

const envelopeV1Base = z.object({
  id,
  occurredAt: isoDate,
  workspace_id: z.string().optional(),
  test: z.literal(true).optional(),
})
const envelopeV2Base = z.object({
  id,
  version: z.literal(2),
  occurredAt: isoDate,
  workspace_id: id,
  test: z.literal(true).optional(),
})

/** The data schema of `name` in `version`, or undefined when not in that version. */
export function webhookDataSchema(name: string, version: WebhookPayloadVersion): z.ZodType | undefined {
  if (version === 1) return (DATA_V1 as Record<string, z.ZodType>)[name]

  return (DATA_V2 as Record<string, z.ZodType>)[name]
}

/** The full envelope schema (envelope + data) of `name` in `version`. */
export function webhookEnvelopeSchema(name: WebhookEventV2, version: WebhookPayloadVersion): z.ZodType | undefined {
  const data = webhookDataSchema(name, version)

  if (!data) return undefined

  const base = version === 1 ? envelopeV1Base : envelopeV2Base

  return base.extend({ name: z.literal(name), data }).describe(`MeetSum webhook ${name} (payload v${version})`)
}

// ---------------------------------------------------------------------------
// Catalog entries: description and a schema-valid example per version.

const EXAMPLE_MEETING = "meet_01HZX5V8Q3"
const EXAMPLE_URL = `https://meetsum.example.com/he?meeting=${EXAMPLE_MEETING}`

type CatalogEntry = {
  description: string
  examples: Partial<Record<WebhookPayloadVersion, Record<string, unknown>>>
}

const CATALOG: Record<WebhookEventV2, CatalogEntry> = {
  "meeting.completed": {
    description: "A meeting finished processing (transcript, summary and action items are ready).",
    examples: {
      1: { meetingId: EXAMPLE_MEETING, title: "סנכרון שבועי" },
      2: {
        meetingId: EXAMPLE_MEETING,
        title: "סנכרון שבועי",
        startedAt: "2026-10-12T07:30:00.000Z",
        durationMs: 1_860_000,
        language: "he",
        participantCount: 4,
        actionItemCount: 3,
        overview: "הצוות סיכם את יעדי הרבעון.",
        url: EXAMPLE_URL,
        visibility: "workspace",
      },
    },
  },
  "summary.created": {
    description: "A meeting summary was generated or regenerated.",
    examples: {
      1: { meetingId: EXAMPLE_MEETING, title: "Weekly sync", tags: ["planning"] },
      2: { meetingId: EXAMPLE_MEETING, title: "Weekly sync", tags: ["planning"], url: EXAMPLE_URL, visibility: "workspace" },
    },
  },
  "action_item.created": {
    description: "An action item was extracted from a meeting (one event per new item).",
    examples: {
      1: { meetingId: EXAMPLE_MEETING, actionItemId: "act_1", title: "Send the plan", owner: "Dana", priority: "high" },
      2: {
        meetingId: EXAMPLE_MEETING,
        actionItemId: "act_1",
        title: "Send the plan",
        owner: "Dana",
        priority: "high",
        url: EXAMPLE_URL,
        visibility: "workspace",
      },
    },
  },
  "meeting.process_failed": {
    description: "A processing job for a meeting failed (permanent: no more retries).",
    examples: {
      1: { meetingId: EXAMPLE_MEETING, jobId: "job_1", jobName: "meeting.transcribe", error: "ASR timeout", attempts: 3, permanent: true },
      2: {
        meetingId: EXAMPLE_MEETING,
        jobId: "job_1",
        jobName: "meeting.transcribe",
        error: "ASR timeout",
        attempts: 3,
        permanent: true,
        visibility: "workspace",
      },
    },
  },
  "realizeos.export.sent": {
    description: "A meeting was exported to RealizeOS.",
    examples: {
      1: { meetingId: EXAMPLE_MEETING, suggestionId: "sug_1", responseStatus: 200 },
      2: { meetingId: EXAMPLE_MEETING, suggestionId: "sug_1", responseStatus: 200, visibility: "workspace" },
    },
  },
  "realizeos.export.failed": {
    description: "A RealizeOS export failed.",
    examples: {
      1: { meetingId: EXAMPLE_MEETING, suggestionId: "sug_1", responseStatus: 502, error: "RealizeOS returned 502" },
      2: {
        meetingId: EXAMPLE_MEETING,
        suggestionId: "sug_1",
        responseStatus: 502,
        error: "RealizeOS returned 502",
        visibility: "workspace",
      },
    },
  },
  "action_item.updated": {
    description: "An action item was edited (status, owner, due date, title or priority). v2 only.",
    examples: {
      2: {
        meetingId: EXAMPLE_MEETING,
        actionItemId: "act_1",
        changed: ["status"],
        title: "Send the plan",
        owner: "Dana",
        status: "done",
        dueDate: "2026-10-20",
        priority: "high",
        url: EXAMPLE_URL,
        visibility: "workspace",
      },
    },
  },
  "clip.created": {
    description: "A clip was cut from a meeting. v2 only.",
    examples: {
      2: {
        meetingId: EXAMPLE_MEETING,
        clipId: "clip_1",
        title: "ההחלטה על התקציב",
        startMs: 125_000,
        endMs: 158_000,
        url: `https://meetsum.example.com/he?meeting=${EXAMPLE_MEETING}&t=125`,
        visibility: "workspace",
      },
    },
  },
  "bot.status_changed": {
    description: "The meeting bot changed status (joining, in call, recording, left, failed…). v2 only.",
    examples: {
      2: { sessionId: "bot_1", meetingId: EXAMPLE_MEETING, status: "in_call_recording" },
    },
  },
  "integration.delivery.failed": {
    description: "An integration delivery (Slack, Notion, HubSpot, email recap) failed for good. v2 only.",
    examples: {
      2: { deliveryId: "intd_1", provider: "slack", meetingId: EXAMPLE_MEETING, reason: "auth" },
    },
  },
}

export function webhookEventDescription(name: WebhookEventV2): string {
  return CATALOG[name].description
}

/** Versions an event exists in. */
export function webhookEventVersions(name: WebhookEventV2): WebhookPayloadVersion[] {
  return (WEBHOOK_EVENTS_V1 as readonly string[]).includes(name) ? [1, 2] : [2]
}

/** The example data of `name` in `version` (schema-valid), or undefined. */
export function webhookExampleData(
  name: WebhookEventV2,
  version: WebhookPayloadVersion
): Record<string, unknown> | undefined {
  const example = CATALOG[name].examples[version]

  return example ? structuredClone(example) : undefined
}

/** Repo path of the generated JSON Schema of `name` (v2). */
export function webhookSchemaPath(name: WebhookEventV2): string {
  return `docs/webhooks/schemas/v2/${name}.schema.json`
}

export type WebhookCatalogEvent = {
  name: WebhookEventV2
  versions: WebhookPayloadVersion[]
  description: string
  /** v2 example envelope data. */
  example: Record<string, unknown>
  schemaUrl: string
}

export function webhookCatalogEvents(): WebhookCatalogEvent[] {
  return WEBHOOK_EVENTS_V2.map((name) => ({
    name,
    versions: webhookEventVersions(name),
    description: webhookEventDescription(name),
    example: webhookExampleData(name, 2) ?? {},
    schemaUrl: webhookSchemaPath(name),
  }))
}

/** JSON Schema (draft 2020-12) of the v2 envelope of `name`. */
export function webhookJsonSchema(name: WebhookEventV2): Record<string, unknown> {
  const schema = webhookEnvelopeSchema(name, 2)

  if (!schema) throw new Error(`No v2 schema for ${name}`)

  return z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>
}
