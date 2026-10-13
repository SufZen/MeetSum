/**
 * Injectable dependencies of the dispatcher and the delivery worker. Owner:
 * Package A. Defaults use the system meeting repository of the event's
 * workspace, the workspace store, the integrations store and queue.
 */
import { getBotConfig } from "@/lib/bot/config"
import { emailDomain } from "@/lib/bot/rules"
import { getIntegrationQueuePort, type IntegrationQueuePort } from "@/lib/integrations/core/queue"
import { getProvider } from "@/lib/integrations/core/registry"
import { getIntegrationStore, type IntegrationStore } from "@/lib/integrations/core/store"
import type { IntegrationProvider } from "@/lib/integrations/core/types"
import type { MeetingRecord } from "@/lib/meetings/repository"
import type { WorkspaceRole } from "@/lib/workspaces/types"

export type WorkspaceMember = { userId: string; email: string; role: WorkspaceRole }

export type IntegrationRuntime = {
  store: IntegrationStore
  queue: IntegrationQueuePort
  getProvider: (id: string) => IntegrationProvider | undefined
  /** System-scope read (workspace filter only). */
  getMeeting(workspaceId: string, meetingId: string): Promise<MeetingRecord | undefined>
  listMembers(workspaceId: string): Promise<WorkspaceMember[]>
  /** Member domains ∪ MEETSUM_BOT_INTERNAL_DOMAINS. */
  internalDomains(workspaceId: string): Promise<string[]>
  workspaceName(workspaceId: string): Promise<string>
  /** `integration.delivery.failed` platform event (ids only). */
  emitDeliveryFailed(workspaceId: string, data: { deliveryId: string; provider: string; meetingId?: string; reason: string }): Promise<void>
  now(): Date
}

export async function defaultIntegrationRuntime(overrides: Partial<IntegrationRuntime> = {}): Promise<IntegrationRuntime> {
  const store = overrides.store ?? (await getIntegrationStore())

  const listMembers =
    overrides.listMembers ??
    (async (workspaceId: string) => {
      const { getWorkspaceStore } = await import("@/lib/workspaces/store")
      const members = await getWorkspaceStore().listMembers(workspaceId)

      return members.map((member) => ({ userId: member.userId, email: member.user.email.toLowerCase(), role: member.role }))
    })

  return {
    store,
    queue: overrides.queue ?? getIntegrationQueuePort(),
    getProvider: overrides.getProvider ?? getProvider,
    getMeeting:
      overrides.getMeeting ??
      (async (workspaceId, meetingId) => {
        const { getSystemMeetingRepository } = await import("@/lib/meetings/store")

        return getSystemMeetingRepository(workspaceId).getMeeting(meetingId)
      }),
    listMembers,
    internalDomains:
      overrides.internalDomains ??
      (async (workspaceId) => {
        const domains = new Set<string>()

        for (const member of await listMembers(workspaceId)) {
          const domain = emailDomain(member.email)

          if (domain) domains.add(domain)
        }
        for (const domain of getBotConfig().internalDomains) {
          const value = domain.trim().toLowerCase().replace(/^@/, "")

          if (value) domains.add(value)
        }
        return [...domains]
      }),
    workspaceName:
      overrides.workspaceName ??
      (async (workspaceId) => {
        const { getWorkspaceStore } = await import("@/lib/workspaces/store")

        return (await getWorkspaceStore().getWorkspace(workspaceId))?.name ?? "MeetSum"
      }),
    emitDeliveryFailed:
      overrides.emitDeliveryFailed ??
      (async (workspaceId, data) => {
        const { emitPlatformEvent } = await import("@/lib/platform/emit")

        await emitPlatformEvent({ workspaceId }, "integration.delivery.failed", data)
      }),
    now: overrides.now ?? (() => new Date()),
  }
}
