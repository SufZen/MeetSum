import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import type { MeetingRecord } from "@/lib/meetings/repository"
import { WEBHOOK_EVENTS_V1, WEBHOOK_EVENTS_V2, type WebhookEventV2 } from "@/lib/platform/event-catalog"
import {
  buildWebhookPayloadV2,
  minimalPrivatePayload,
  platformEventPayload,
  resolveWebhookPayloadV2,
} from "@/lib/platform/event-payloads"
import {
  MEETING_SCOPED_EVENTS,
  PRIVATE_PAYLOAD_KEYS,
  webhookCatalogEvents,
  webhookDataSchema,
  webhookEnvelopeSchema,
  webhookExampleData,
  webhookJsonSchema,
  webhookSchemaPath,
} from "@/lib/platform/event-schemas"

/**
 * M8 C4: every payload builder validates against its schema for workspace
 * and private meetings; private payloads keep only allowlisted keys; the
 * generated JSON Schemas are up to date.
 */

const WS = "ws_1"

function meeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "meet_1",
    workspaceId: WS,
    title: "סנכרון שבועי",
    source: "upload",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-10-12T07:30:00.000Z",
    durationMs: 1_800_000,
    participants: ["Dana", "Alex"],
    visibility: "workspace",
    summary: {
      overview: "תוכנית הרבעון",
      decisions: ["לשחרר בספטמבר"],
      actionItems: [{ id: "act_1", title: "לשלוח תוכנית", owner: "דנה", status: "done", dueOn: "2026-10-20", priority: "high" }],
    },
    ...overrides,
  }
}

/** Raw data as each call site emits it today. */
const RAW: Record<WebhookEventV2, Record<string, unknown>> = {
  "meeting.completed": { meetingId: "meet_1", title: "סנכרון שבועי", mode: "full" },
  "summary.created": { meetingId: "meet_1", title: "סנכרון שבועי", tags: ["planning"] },
  "action_item.created": { meetingId: "meet_1", actionItemId: "act_1", title: "לשלוח תוכנית", owner: "דנה", priority: "high" },
  "meeting.process_failed": {
    meetingId: "meet_1",
    jobId: "job_1",
    jobName: "meeting.transcribe",
    error: "boom with secret text",
    attempts: 2,
    permanent: true,
  },
  "realizeos.export.sent": { meetingId: "meet_1", suggestionId: "sug_1", responseStatus: 200 },
  "realizeos.export.failed": { meetingId: "meet_1", suggestionId: "sug_1", responseStatus: 500, error: "bad" },
  "action_item.updated": { meetingId: "meet_1", actionItemId: "act_1", changed: ["status"] },
  "clip.created": { meetingId: "meet_1", clipId: "clip_1" },
  "bot.status_changed": { sessionId: "bot_1", meetingId: "meet_1", status: "in_call_recording", reason: null },
  "integration.delivery.failed": { deliveryId: "intd_1", provider: "slack", meetingId: "meet_1", reason: "auth" },
}

const CLIP = { title: "ההחלטה", startMs: 125_000, endMs: 158_000 }
const ENV = { NEXT_PUBLIC_APP_URL: "https://meetsum.example.com" } as unknown as NodeJS.ProcessEnv

function expectValid(name: WebhookEventV2, version: 1 | 2, data: Record<string, unknown>) {
  const result = webhookDataSchema(name, version)!.safeParse(data)

  expect(result.success, `${name} v${version}: ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true)
}

describe("v2 payload builders", () => {
  for (const name of WEBHOOK_EVENTS_V2) {
    it(`${name}: workspace payload validates`, () => {
      const data = buildWebhookPayloadV2(name, RAW[name], { workspaceId: WS, meeting: meeting(), clip: CLIP, env: ENV })

      expectValid(name, 2, data)
    })

    it(`${name}: private payload validates and keeps only allowlisted keys`, () => {
      const data = buildWebhookPayloadV2(name, RAW[name], {
        workspaceId: WS,
        meeting: meeting({ visibility: "private" }),
        clip: CLIP,
        env: ENV,
      })

      expectValid(name, 2, data)
      if (MEETING_SCOPED_EVENTS.includes(name)) {
        const allowed = new Set<string>([...PRIVATE_PAYLOAD_KEYS, "workspace_id", "visibility"])

        expect(data.visibility).toBe("private")
        expect(Object.keys(data).filter((key) => !allowed.has(key))).toEqual([])
        expect(JSON.stringify(data)).not.toMatch(/סנכרון|לשלוח|דנה|ההחלטה|secret text|planning/)
      }
    })
  }

  it("fails closed when the meeting cannot be read (unknown visibility → private)", () => {
    const data = buildWebhookPayloadV2("meeting.completed", RAW["meeting.completed"], { workspaceId: WS })

    expect(data).toEqual({ meetingId: "meet_1", mode: "full", workspace_id: WS, visibility: "private" })
  })

  it("fails closed when the meeting record has no visibility (undefined → private)", () => {
    const data = buildWebhookPayloadV2("meeting.completed", RAW["meeting.completed"], {
      workspaceId: WS,
      meeting: meeting({ visibility: undefined }),
      env: ENV,
    })

    expect(data).toEqual({ meetingId: "meet_1", mode: "full", workspace_id: WS, visibility: "private" })
  })

  it("keeps an already-minimized v1 private payload minimal", () => {
    const v1Private = minimalPrivatePayload(WS, RAW["summary.created"])
    const data = buildWebhookPayloadV2("summary.created", v1Private, { workspaceId: WS, meeting: meeting() })

    expect(data).toEqual({ meetingId: "meet_1", workspace_id: WS, visibility: "private" })
  })

  it("enriches meeting.completed with the catalog fields", () => {
    const data = buildWebhookPayloadV2("meeting.completed", RAW["meeting.completed"], {
      workspaceId: WS,
      meeting: meeting(),
      env: ENV,
    })

    expect(data).toEqual({
      meetingId: "meet_1",
      title: "סנכרון שבועי",
      mode: "full",
      startedAt: "2026-10-12T07:30:00.000Z",
      durationMs: 1_800_000,
      language: "he",
      participantCount: 2,
      actionItemCount: 1,
      overview: "תוכנית הרבעון",
      url: "https://meetsum.example.com/he?meeting=meet_1",
      visibility: "workspace",
    })
  })

  it("re-reads the meeting and clip through the loaders and never throws", async () => {
    const data = await resolveWebhookPayloadV2("clip.created", RAW["clip.created"], { workspaceId: WS }, {
      loadMeeting: async () => meeting(),
      loadClip: async () => ({ ...CLIP, id: "clip_1", meetingId: "meet_1" }) as never,
      env: ENV,
    })

    expect(data).toMatchObject({ clipId: "clip_1", startMs: 125_000, endMs: 158_000, url: expect.stringContaining("t=125") })

    const failed = await resolveWebhookPayloadV2("clip.created", RAW["clip.created"], { workspaceId: WS }, {
      loadMeeting: async () => {
        throw new Error("db down")
      },
    })

    expect(failed).toEqual({ meetingId: "meet_1", clipId: "clip_1", workspace_id: WS, visibility: "private" })
  })

  it("ignores a meeting of another workspace", async () => {
    const data = await resolveWebhookPayloadV2("meeting.completed", RAW["meeting.completed"], { workspaceId: WS }, {
      loadMeeting: async () => meeting({ workspaceId: "ws_2" }),
    })

    expect(data.visibility).toBe("private")
  })
})

describe("v1 payloads", () => {
  it("stay unchanged and validate for the v1 events", () => {
    for (const name of WEBHOOK_EVENTS_V1) {
      const raw = { ...RAW[name] }

      expect(platformEventPayload(name, raw)).toBe(raw)
      expectValid(name, 1, raw)
      expectValid(name, 1, minimalPrivatePayload(WS, raw))
    }
  })

  it("have no schema for v2-only events", () => {
    expect(webhookDataSchema("clip.created", 1)).toBeUndefined()
    expect(webhookEnvelopeSchema("bot.status_changed", 1)).toBeUndefined()
  })
})

describe("catalog examples and generated JSON Schemas", () => {
  it("every example validates against its envelope schema in each version", () => {
    for (const entry of webhookCatalogEvents()) {
      for (const version of entry.versions) {
        const envelope = {
          id: "evt_example",
          name: entry.name,
          ...(version === 2 ? { version: 2 } : {}),
          occurredAt: "2026-10-12T10:00:00.000Z",
          workspace_id: WS,
          data: webhookExampleData(entry.name, version),
          test: true,
        }

        expect(webhookEnvelopeSchema(entry.name, version)!.safeParse(envelope).success, `${entry.name} v${version}`).toBe(true)
      }
    }
  })

  it("docs/webhooks/schemas/v2 matches the zod schemas (run npm run webhooks:schemas)", () => {
    for (const name of WEBHOOK_EVENTS_V2) {
      const file = path.join(process.cwd(), webhookSchemaPath(name))
      const onDisk = JSON.parse(readFileSync(file, "utf8")) as unknown

      expect(onDisk, name).toEqual(webhookJsonSchema(name))
    }
  })
})
