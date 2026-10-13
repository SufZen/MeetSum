import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createIntegrationWorld, hebrewMeeting, NOTION_DB, SLACK_CHANNEL, standardRules, type World } from "./helpers/integration-world"

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

import { createManualDelivery } from "@/lib/integrations/core/deliveries"
import { getIntegrationQueuePort } from "@/lib/integrations/core/queue"
import { DEFAULT_RULE_CONTENT } from "@/lib/integrations/recap"
import type { MeetingRecord } from "@/lib/meetings/repository"

/**
 * M8 Integration step, end to end with the fake providers (in process, the
 * same server `npm run integrations:fake` runs): a meeting completes, the
 * rules dispatch to Slack, Notion and HubSpot plus the email recap; the
 * event replayed posts nothing new; a re-send after the summary changed
 * updates every object in place, with no duplicates.
 */

const RLM = "‏"

describe("meeting completed → Slack, Notion, HubSpot and email recap (fake providers)", () => {
  let world: World

  beforeEach(async () => {
    world = await createIntegrationWorld([hebrewMeeting({ id: "m_he" })])
    await standardRules(world)
  })

  afterEach(async () => {
    await world.close()
  })

  it("delivers every rule once, then re-sends in place without duplicates", async () => {
    await world.dispatch("m_he")

    const deliveries = await world.store.listDeliveries("ws_a")

    expect(deliveries.map((row) => [row.provider, row.status]).sort()).toEqual([
      ["email", "sent"],
      ["hubspot", "sent"],
      ["notion", "sent"],
      ["slack", "sent"],
    ])

    // Slack: one Block Kit post, RLM-prefixed Hebrew lines, an "Open in MeetSum" link.
    const posts = world.providerRequests("slack", "chat.postMessage")

    expect(posts).toHaveLength(1)

    const post = posts[0]?.body as { channel: string; blocks: unknown[] }
    const postText = JSON.stringify(post)

    expect(post.channel).toBe(SLACK_CHANNEL)
    expect(post.blocks.length).toBeLessThanOrEqual(50)
    expect(postText).toContain(RLM)
    expect(postText).toContain("https://meetsum.test/he?meeting=m_he")

    // Notion: one page in the database, every rich_text ≤ 2000 characters.
    const pages = world.providerRequests("notion", "/v1/pages", "POST")

    expect(pages).toHaveLength(1)
    expect((pages[0]?.body as { parent: { database_id: string } }).parent.database_id).toBe(NOTION_DB)
    for (const request of world.providerRequests("notion")) {
      for (const match of JSON.stringify(request.body ?? {}).matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)) {
        expect(JSON.parse(`"${match[1]}"`).length).toBeLessThanOrEqual(2000)
      }
    }

    // HubSpot: one meeting engagement and one task batch for the open action items.
    expect(world.providerRequests("hubspot", "/crm/v3/objects/meetings", "POST")).toHaveLength(1)
    expect(world.providerRequests("hubspot", "/crm/v3/objects/tasks/batch/create")).toHaveLength(1)

    // Email recap (members audience): one email to the attending member, RTL HTML.
    expect(world.emails.map((message) => message.to)).toEqual(["owner@acme.test"])
    expect(world.emails[0]?.html).toContain('dir="rtl"')

    // Replaying the event never re-posts (one delivery per rule, meeting and event).
    const before = world.server.requests().length

    await world.dispatch("m_he")
    expect(await world.store.listDeliveries("ws_a")).toHaveLength(4)
    expect(world.server.requests().length).toBe(before)
    expect(world.emails).toHaveLength(1)

    // The summary changes; a manual re-send to each provider updates in place.
    const changed = hebrewMeeting({ id: "m_he" })

    ;(changed.summary as NonNullable<MeetingRecord["summary"]>).overview = "עדכון: הפיילוט נדחה לדצמבר."
    world.rt.meetings.set("m_he", changed)

    const pageId = (deliveries.find((row) => row.provider === "notion")?.externalRef as { pageId?: string }).pageId
    const resend = async (connectionId: string, provider: "slack" | "notion" | "hubspot", destination: Parameters<typeof createManualDelivery>[2]["request"]["destination"]) =>
      createManualDelivery(world.store, getIntegrationQueuePort(), {
        workspaceId: "ws_a",
        connectionId,
        provider,
        meetingId: "m_he",
        requestedByUserId: "user_admin",
        request: { destination, content: { ...DEFAULT_RULE_CONTENT } },
      })

    await resend(world.connections.slack, "slack", { provider: "slack", channelId: SLACK_CHANNEL, channelName: "general" })
    await resend(world.connections.notion, "notion", { provider: "notion", databaseId: NOTION_DB, databaseTitle: "" })
    await resend(world.connections.hubspot, "hubspot", {
      provider: "hubspot",
      logAs: "meeting",
      createTasks: true,
      createMissingContacts: true,
      matchInternal: false,
    })
    await world.drain()

    const manual = (await world.store.listDeliveries("ws_a")).filter((row) => row.origin === "manual")

    expect(manual.map((row) => row.status)).toEqual(["sent", "sent", "sent"])

    // Slack: chat.update of the same message, no second post.
    expect(world.providerRequests("slack", "chat.postMessage")).toHaveLength(1)
    expect(world.providerRequests("slack", "chat.update")).toHaveLength(1)
    expect((world.providerRequests("slack", "chat.update")[0]?.body as { ts: string }).ts).toBe(
      (deliveries.find((row) => row.provider === "slack")?.externalRef as { ts?: string }).ts
    )

    // Notion: the same page is patched; no new page.
    expect(world.providerRequests("notion", "/v1/pages", "POST")).toHaveLength(1)
    expect(world.providerRequests("notion", `/v1/pages/${pageId}`, "PATCH")).toHaveLength(1)

    // HubSpot: the engagement is PATCHed; no new engagement and no new tasks.
    expect(world.providerRequests("hubspot", "/crm/v3/objects/meetings", "POST")).toHaveLength(1)
    expect(world.providerRequests("hubspot", "/crm/v3/objects/meetings/", "PATCH")).toHaveLength(1)
    expect(world.providerRequests("hubspot", "/crm/v3/objects/tasks/batch/create")).toHaveLength(1)
  })
})
