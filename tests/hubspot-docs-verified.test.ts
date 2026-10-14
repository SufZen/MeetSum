import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import type { HubspotClient } from "@/lib/integrations/hubspot/client"
import { ASSOCIATION_TYPE_IDS, createTaskBatch, taskProperties } from "@/lib/integrations/hubspot/engagements"
import type { MeetingRecap, MeetingRecapActionItem } from "@/lib/integrations/recap"

/**
 * M10 R2: HubSpot behaviour checked against the vendor docs on 2026-10-14
 * (docs/runbooks/integrations.md, "Verified against vendor docs").
 */

const recap = {
  title: "סקירת תקציב",
  links: { meeting: "https://meetsum.example/m/1" },
  startedAt: "2026-10-14T10:00:00.000Z",
  durationMs: 1_800_000,
} as unknown as MeetingRecap
const item = (overrides: Partial<MeetingRecapActionItem> = {}) =>
  ({ id: "ai_1", title: "לשלוח הצעה", ...overrides }) as unknown as MeetingRecapActionItem

function fakeClient(response: unknown): HubspotClient {
  return { request: async <T,>() => response as T }
}

describe("HubSpot OAuth endpoints", () => {
  it("uses the date-versioned /oauth/2026-03 paths, never the deprecated v1/v3 token endpoints", () => {
    for (const file of ["lib/integrations/hubspot/oauth.ts", "lib/integrations/hubspot/fake.ts"]) {
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

      expect(code, file).toContain("/oauth/2026-03/token")
      expect(code, file).not.toMatch(/\/oauth\/v[13]\//)
    }
  })
})

describe("HubSpot association type ids (HUBSPOT_DEFINED)", () => {
  it("match the associations v4 guide", () => {
    expect(ASSOCIATION_TYPE_IDS).toMatchObject({
      meeting: { contact: 200, deal: 212 },
      note: { contact: 202, deal: 214 },
      task: { contact: 204, deal: 216 },
    })
  })
})

describe("HubSpot task properties", () => {
  it("omits hs_task_priority when the item has none (only LOW, MEDIUM, HIGH are documented)", () => {
    expect(taskProperties(item(), recap, undefined)).not.toHaveProperty("hs_task_priority")
    expect(taskProperties(item({ priority: "high" }), recap, undefined).hs_task_priority).toBe("HIGH")
  })
})

describe("HubSpot task batch mapping", () => {
  const inputs = ["ai_1", "ai_2", "ai_3"].map((actionItemId) => ({ actionItemId, properties: {} }))
  const target = { contactIds: ["c1"] }

  it("maps nothing when a partial result set does not echo objectWriteTraceId", async () => {
    const map = await createTaskBatch(fakeClient({ results: [{ id: "t1" }, { id: "t2" }] }), inputs, target)

    expect(map.size).toBe(0)
  })

  it("maps by index only when every input got a result", async () => {
    const map = await createTaskBatch(fakeClient({ results: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] }), inputs, target)

    expect([...map.entries()]).toEqual([
      ["ai_1", "t1"],
      ["ai_2", "t2"],
      ["ai_3", "t3"],
    ])
  })

  it("maps a partial result set by the echoed trace id", async () => {
    const map = await createTaskBatch(fakeClient({ results: [{ id: "t3", objectWriteTraceId: "ai_3" }] }), inputs, target)

    expect([...map.entries()]).toEqual([["ai_3", "t3"]])
  })
})
