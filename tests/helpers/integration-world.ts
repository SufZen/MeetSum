/**
 * An in-process M8 "world" for the Integration-step tests: the real
 * dispatcher, delivery worker, providers (Slack, Notion, HubSpot, email
 * recap) and A's wiring, over a memory store, the merged fake provider
 * server on loopback (fake mode, as the e2e) and a recording email sender.
 * Tokens are fixture canaries so leak tests can grep for them.
 */
import { vi } from "vitest"

import type { EmailMessage } from "@/lib/email/types"
import { runIntegrationDelivery } from "@/lib/integrations/core/deliver"
import { runIntegrationDispatch } from "@/lib/integrations/core/dispatcher"
import { getProvider, listProviders } from "@/lib/integrations/core/registry"
import { setIntegrationQueuePortForTesting } from "@/lib/integrations/core/queue"
import { setIntegrationStoreForTesting, type IntegrationStore, type NewRule } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import { sealTokenSet } from "@/lib/integrations/core/tokens"
import type { ProviderId, RuleTrigger } from "@/lib/integrations/core/types"
import { createEmailRecapProvider } from "@/lib/integrations/email-recap/provider"
import { configureHubspotProvider } from "@/lib/integrations/hubspot/provider"
import { allProviderFakeHandlers, createFakeProviderServer, type FakeProviderServer } from "@/lib/integrations/testing/fake-server"
import { createRecordingQueue, createTestRuntime, testMeetingRecord, testRule, type TestRuntime } from "@/lib/integrations/testing/harness"
import { DEFAULT_RULE_CONTENT } from "@/lib/integrations/recap"
import type { MeetingRecord } from "@/lib/meetings/repository"

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

/** Fixture tokens (the Slack fake only accepts `fake-slack-*`). */
export const CANARY = {
  slack: { access: "fake-slack-bot-CANARY7731", refresh: "fake-slack-refresh-CANARY7732" },
  notion: { access: "secret_notionCANARY7733", refresh: "notion-refresh-CANARY7734" },
  hubspot: { access: "hubspot-access-CANARY7735", refresh: "hubspot-refresh-CANARY7736" },
  slackB: { access: "fake-slack-bot-CANARY7737", refresh: "fake-slack-refresh-CANARY7738" },
} as const

export const CANARY_VALUES = Object.values(CANARY).flatMap((pair) => [pair.access, pair.refresh])

export const SLACK_CHANNEL = "C000001"
export const NOTION_DB = "fake-notion-db-0001"

function participants(meetingId: string, emails: string[]): MeetingRecord["participantDetails"] {
  return emails.map((email, index) => ({
    id: `p${index + 1}`,
    meetingId,
    name: email.split("@")[0],
    email,
    role: index === 0 ? "organizer" : "attendee",
    source: "calendar",
    attendanceStatus: "accepted",
    createdAt: "",
    updatedAt: "",
  })) as MeetingRecord["participantDetails"]
}

/** A completed Hebrew meeting with a summary, decisions and two open action items. */
export function hebrewMeeting(overrides: Partial<MeetingRecord> & { id: string }): MeetingRecord {
  return testMeetingRecord({
    title: "פגישת סטטוס עם לקוח",
    durationMs: 30 * 60_000,
    participantDetails: participants(overrides.id, ["owner@acme.test", "client@customer.example"]),
    summary: {
      overview: "סיכמנו את לוח הזמנים לפיילוט ואת הצעדים הבאים.",
      actionItems: [
        { id: "ai_1", title: "לשלוח הצעת מחיר", status: "open", ownerParticipantId: "p1", dueOn: "2026-10-20" },
        { id: "ai_2", title: "Book the follow-up", status: "open" },
      ],
      decisions: ["להתקדם לפיילוט בנובמבר"],
    } as unknown as MeetingRecord["summary"],
    ...overrides,
  })
}

export type World = {
  rt: TestRuntime
  store: IntegrationStore
  server: FakeProviderServer
  emails: EmailMessage[]
  connections: Record<"slack" | "notion" | "hubspot" | "slackB", string>
  /** Dispatches a rule event, then runs every queued delivery job. */
  dispatch(meetingId: string, options?: { workspaceId?: string; trigger?: RuleTrigger; actionItemId?: string }): Promise<void>
  /** Runs the `integration.deliver` jobs not run yet. */
  drain(): Promise<void>
  rule(overrides: Partial<NewRule>): Promise<string>
  providerRequests(provider: string, pathPart?: string, method?: string): ReturnType<FakeProviderServer["requests"]>
  close(): Promise<void>
}

export async function createIntegrationWorld(meetings: MeetingRecord[]): Promise<World> {
  const store = createMemoryIntegrationStore()
  const rt = createTestRuntime({ store, meetings })
  const emails: EmailMessage[] = []
  const server = await createFakeProviderServer(allProviderFakeHandlers(listProviders()))

  vi.stubEnv("MEETSUM_INTEGRATIONS_FAKE_BASE_URL", server.url)
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://meetsum.test")
  setIntegrationStoreForTesting(store)
  setIntegrationQueuePortForTesting(createRecordingQueue(rt.jobs))
  // Keep A's wiring (fetch + privacy gate); only the workspace lookups are local.
  configureHubspotProvider({
    internalDomains: async () => ["acme.test"],
    memberEmails: async (workspaceId) => new Map((await rt.listMembers(workspaceId)).map((member) => [member.userId, member.email])),
  })

  const email = createEmailRecapProvider({
    store: async () => store,
    sender: () => ({
      provider: "log",
      isConfigured: () => true,
      async send(message) {
        emails.push(message)
        return { provider: "log", messageId: `msg_${emails.length}` }
      },
    }),
    listMembers: (workspaceId) => rt.listMembers(workspaceId),
    workspaceName: async () => "Acme",
    sleep: async () => undefined,
  })

  rt.getProvider = (id) => (id === "email" ? email : (rt.providers.get(id) ?? getProvider(id)))

  async function connect(id: string, workspaceId: string, provider: ProviderId, tokens: { access: string; refresh: string }) {
    const created = await store.createConnection({
      id,
      workspaceId,
      provider,
      status: "active",
      accountLabel: `${provider} test`,
      externalAccountId: `${id}_ext`,
      scopes: [],
      ...sealTokenSet(workspaceId, id, { accessToken: tokens.access, refreshToken: tokens.refresh, scopes: [] }),
      config: {},
      createdByUserId: "user_admin",
    })

    if (!created.ok) throw new Error("world setup")
    return id
  }

  const connections = {
    slack: await connect("intc_slack", "ws_a", "slack", CANARY.slack),
    notion: await connect("intc_notion", "ws_a", "notion", CANARY.notion),
    hubspot: await connect("intc_hubspot", "ws_a", "hubspot", CANARY.hubspot),
    slackB: await connect("intc_slack_b", "ws_b", "slack", CANARY.slackB),
  }
  let ran = 0

  const world: World = {
    rt,
    store,
    server,
    emails,
    connections,
    async drain() {
      while (ran < rt.jobs.length) {
        const job = rt.jobs[ran]

        ran += 1
        if (job?.name !== "integration.deliver") continue

        const payload = job.payload as { workspaceId: string; deliveryId: string }

        await runIntegrationDelivery({ workspaceId: payload.workspaceId, deliveryId: payload.deliveryId, finalAttempt: true }, rt)
      }
    },
    async dispatch(meetingId, options = {}) {
      await runIntegrationDispatch(
        {
          workspaceId: options.workspaceId ?? "ws_a",
          eventName: options.trigger ?? "meeting.completed",
          eventId: `evt_${meetingId}_${options.trigger ?? "meeting.completed"}`,
          meetingId,
          ...(options.actionItemId ? { actionItemId: options.actionItemId } : {}),
        },
        rt
      )
      await world.drain()
    },
    async rule(overrides) {
      const created = await store.createRule(testRule({ content: { ...DEFAULT_RULE_CONTENT }, ...overrides }))

      if (!created.ok) throw new Error(`rule setup: ${created.reason}`)
      return created.rule.id
    },
    providerRequests(provider, pathPart, method) {
      return server
        .requests(provider)
        .filter((request) => (!pathPart || request.path.includes(pathPart)) && (!method || request.method === method))
    },
    async close() {
      setIntegrationStoreForTesting(undefined)
      setIntegrationQueuePortForTesting(undefined)
      vi.unstubAllEnvs()
      await server.close()
    },
  }

  return world
}

/** The four rule kinds of the spec, all created by the W1 admin. */
export async function standardRules(world: World, overrides: Partial<NewRule> = {}) {
  return {
    slack: await world.rule({
      provider: "slack",
      connectionId: world.connections.slack,
      destination: { provider: "slack", channelId: SLACK_CHANNEL, channelName: "general" },
      ...overrides,
    }),
    notion: await world.rule({
      provider: "notion",
      connectionId: world.connections.notion,
      destination: { provider: "notion", databaseId: NOTION_DB, databaseTitle: "פגישות" },
      ...overrides,
    }),
    hubspot: await world.rule({
      provider: "hubspot",
      connectionId: world.connections.hubspot,
      destination: { provider: "hubspot", logAs: "meeting", createTasks: true, createMissingContacts: true, matchInternal: false },
      ...overrides,
    }),
    email: await world.rule({
      provider: "email",
      connectionId: null,
      destination: { provider: "email", audience: "members", mode: "all_meetings", locale: "meeting" },
      ...overrides,
    }),
  }
}
