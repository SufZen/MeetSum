/**
 * Notification sentences (docs/parity/m9.md C1): one dictionary template per
 * kind, split into text and slot parts so the bell can wrap names, titles and
 * workspace names in <bdi>. A meeting the reader can no longer see renders
 * the generic "meeting unavailable" label, never a title. Client-safe, pure.
 */
import type { NotificationDTO, NotificationKind } from "@/lib/notifications/types"

export type SentencePart = { text: string } | { slot: "actor" | "meeting" | "workspace" | "provider"; value: string; lang?: string | null }

const TEMPLATE: Record<NotificationKind, string> = {
  mention: "notifKindMention",
  reply: "notifKindReply",
  task_assigned: "notifKindTaskAssigned",
  integration_reauth: "notifKindIntegrationReauth",
  invited: "notifKindInvited",
  meeting_processed: "notifKindMeetingProcessed",
  meeting_failed: "notifKindMeetingFailed",
  bot_blocked: "notifKindBotBlocked",
}

const NO_ACTOR: Partial<Record<NotificationKind, string>> = {
  mention: "notifKindMentionNoActor",
  reply: "notifKindReplyNoActor",
  task_assigned: "notifKindTaskAssignedNoActor",
}

/** Display names of integration providers (brands, not translated). */
const PROVIDERS: Record<string, string> = {
  slack: "Slack",
  notion: "Notion",
  hubspot: "HubSpot",
  google: "Google",
  google_docs: "Google Docs",
  microsoft: "Microsoft",
  teams: "Teams",
  zoom: "Zoom",
  outlook: "Outlook",
  realizeos: "RealizeOS",
}

export function providerName(provider: unknown): string {
  return typeof provider === "string" ? PROVIDERS[provider] ?? provider : ""
}

/** The template key used for a notification (exported for tests). */
export function notificationTemplateKey(dto: Pick<NotificationDTO, "kind" | "actor">): string {
  return !dto.actor && NO_ACTOR[dto.kind] ? NO_ACTOR[dto.kind]! : TEMPLATE[dto.kind]
}

export function notificationSentence(
  dto: NotificationDTO,
  t: (key: string) => string
): SentencePart[] {
  const template = t(notificationTemplateKey(dto))
  const meetingTitle = dto.meeting?.title ?? null
  const values: Record<string, SentencePart> = {
    actor: { slot: "actor", value: dto.actor?.name ?? "" },
    meeting: meetingTitle
      ? { slot: "meeting", value: meetingTitle, lang: dto.meeting?.language ?? null }
      : { text: t("notifMeetingUnavailable") },
    workspace: {
      slot: "workspace",
      value: typeof dto.payload.workspaceName === "string" ? dto.payload.workspaceName : t("notifWorkspaceFallback"),
    },
    provider: { slot: "provider", value: providerName(dto.payload.provider) },
  }
  const parts: SentencePart[] = []
  let last = 0

  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const index = match.index ?? 0

    if (index > last) parts.push({ text: template.slice(last, index) })
    parts.push(values[match[1] ?? ""] ?? { text: match[0] })
    last = index + match[0].length
  }
  if (last < template.length) parts.push({ text: template.slice(last) })

  return parts
}

/** Plain-text sentence (screen-reader labels, tests). */
export function notificationText(dto: NotificationDTO, t: (key: string) => string): string {
  return notificationSentence(dto, t)
    .map((part) => ("text" in part ? part.text : part.value))
    .join("")
}
