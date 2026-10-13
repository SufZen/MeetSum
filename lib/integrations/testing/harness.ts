/**
 * Test harness for the dispatcher / delivery worker (Package A). Builds an
 * IntegrationRuntime over a memory store, an in-memory meeting map, a fake
 * member list and a recording queue. Never used outside tests.
 */
import type { IntegrationJobName, IntegrationJobPayloads, IntegrationQueuePort } from "@/lib/integrations/core/queue"
import type { IntegrationRuntime, WorkspaceMember } from "@/lib/integrations/core/runtime"
import type { IntegrationStore, NewRule } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import type { IntegrationProvider } from "@/lib/integrations/core/types"
import { DEFAULT_RULE_CONTENT } from "@/lib/integrations/recap"
import type { MeetingRecord } from "@/lib/meetings/repository"

export type RecordedJob = { name: IntegrationJobName; payload: unknown; jobId?: string }

export type TestRuntime = IntegrationRuntime & {
  jobs: RecordedJob[]
  meetings: Map<string, MeetingRecord>
  members: Map<string, WorkspaceMember[]>
  providers: Map<string, IntegrationProvider>
  failures: { workspaceId: string; data: Record<string, unknown> }[]
}

export function createRecordingQueue(jobs: RecordedJob[]): IntegrationQueuePort {
  return {
    async enqueue<Name extends IntegrationJobName>(name: Name, payload: IntegrationJobPayloads[Name], options: { jobId?: string } = {}) {
      jobs.push({ name, payload, ...(options.jobId ? { jobId: options.jobId } : {}) })
    },
  }
}

export function testMeetingRecord(overrides: Partial<MeetingRecord> & { id: string }): MeetingRecord {
  return {
    title: `Meeting ${overrides.id}`,
    source: "upload",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-10-01T10:00:00.000Z",
    participants: [],
    workspaceId: "ws_a",
    ownerUserId: "user_owner",
    visibility: "workspace",
    summary: {
      overview: "סקירה של הפגישה",
      actionItems: [],
      decisions: ["להשיק בנובמבר"],
    } as unknown as MeetingRecord["summary"],
    ...overrides,
  }
}

export function createTestRuntime(options: { store?: IntegrationStore; meetings?: MeetingRecord[] } = {}): TestRuntime {
  const jobs: RecordedJob[] = []
  const meetings = new Map((options.meetings ?? []).map((meeting) => [meeting.id, meeting]))
  const members = new Map<string, WorkspaceMember[]>([
    [
      "ws_a",
      [
        { userId: "user_owner", email: "owner@acme.test", role: "member" },
        { userId: "user_admin", email: "admin@acme.test", role: "admin" },
        { userId: "user_member", email: "member@acme.test", role: "member" },
      ],
    ],
    ["ws_b", [{ userId: "user_b", email: "b@other.test", role: "owner" }]],
  ])
  const providers = new Map<string, IntegrationProvider>()
  const failures: TestRuntime["failures"] = []

  return {
    store: options.store ?? createMemoryIntegrationStore(),
    queue: createRecordingQueue(jobs),
    getProvider: (id) => providers.get(id),
    getMeeting: async (workspaceId, meetingId) => {
      const meeting = meetings.get(meetingId)

      return meeting && (meeting.workspaceId ?? "ws_a") === workspaceId ? structuredClone(meeting) : undefined
    },
    listMembers: async (workspaceId) => members.get(workspaceId) ?? [],
    internalDomains: async () => ["acme.test"],
    workspaceName: async () => "Acme",
    emitDeliveryFailed: async (workspaceId, data) => {
      failures.push({ workspaceId, data })
    },
    now: () => new Date(),
    jobs,
    meetings,
    members,
    providers,
    failures,
  }
}

let counter = 0

export function testRule(overrides: Partial<NewRule> = {}): NewRule {
  counter += 1
  return {
    id: `intr_t${counter}`,
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
