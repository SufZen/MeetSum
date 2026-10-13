/**
 * Pure state helpers for Settings → Integrations and the per-meeting controls
 * (docs/parity/m8.md, Package D). No React and no fetch, so they run in the
 * vitest node environment.
 */
import type {
  ConnectionStatus,
  DeliverySkipReason,
  DeliveryStatus,
  IntegrationConnectionDTO,
  IntegrationDeliveryDTO,
  IntegrationErrorCode,
  IntegrationRuleDTO,
  ProviderId,
  ProviderInfo,
  RuleContent,
  RuleDestination,
  RuleFilters,
  RuleProviderId,
  RuleTrigger,
  WorkspaceProviderId,
} from "@/lib/integrations/core/types"
import { INTEGRATION_ERROR_CODES, WORKSPACE_PROVIDER_IDS } from "@/lib/integrations/core/types"
import type { IntegrationsMessageKey } from "@/components/integrations/messages"
import type { MeetingVisibility } from "@/lib/meetings/repository"

// ---------------------------------------------------------------------------
// Providers and connections

export const PROVIDER_LABEL_KEYS: Record<ProviderId | "email", IntegrationsMessageKey> = {
  slack: "integrationsProviderSlack",
  notion: "integrationsProviderNotion",
  hubspot: "integrationsProviderHubspot",
  microsoft: "integrationsProviderMicrosoft",
  google_drive: "integrationsProviderGoogleDrive",
  email: "integrationsProviderEmail",
}

export const PROVIDER_HINT_KEYS: Record<ProviderId, IntegrationsMessageKey> = {
  slack: "integrationsProviderSlackHint",
  notion: "integrationsProviderNotionHint",
  hubspot: "integrationsProviderHubspotHint",
  microsoft: "integrationsProviderMicrosoftHint",
  google_drive: "integrationsProviderGoogleDriveHint",
}

export function isWorkspaceProvider(provider: string): provider is WorkspaceProviderId {
  return (WORKSPACE_PROVIDER_IDS as readonly string[]).includes(provider)
}

/** Status pills appear only for exceptions (README §1.5, m8 "Design system"). */
export function connectionPill(
  status: ConnectionStatus | undefined
): { tone: "review" | "failed"; key: IntegrationsMessageKey } | null {
  if (status === "needs_reauth") return { tone: "review", key: "integrationsStatusNeedsReauth" }
  if (status === "error") return { tone: "failed", key: "integrationsStatusError" }

  return null
}

/** The live (non-revoked) connections of one provider, newest first. */
export function activeConnectionsFor(
  connections: readonly IntegrationConnectionDTO[],
  provider: ProviderId,
  userId?: string
): IntegrationConnectionDTO[] {
  return connections
    .filter((connection) => connection.provider === provider && connection.status !== "revoked")
    .filter((connection) => (userId === undefined ? true : connection.userId === userId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export type CardAction = "connect" | "reconnect" | null

/**
 * The single primary action of a provider card: Connect when nothing is
 * connected, Reconnect when the connection is broken, nothing otherwise. A
 * provider that isn't configured, or a viewer who can't manage it, gets none.
 */
export function primaryCardAction(params: {
  connection: IntegrationConnectionDTO | undefined
  configured: boolean
  canManage: boolean
}): CardAction {
  if (!params.canManage) return null
  if (!params.connection) return params.configured ? "connect" : null
  if (params.connection.status === "needs_reauth" || params.connection.status === "error") {
    return params.configured ? "reconnect" : null
  }

  return null
}

export function providerInfoFor(providers: readonly ProviderInfo[], id: ProviderId | "email") {
  return providers.find((provider) => provider.id === id)
}

/** Full-page navigation target for Connect / Reconnect. `returnTo` stays same-origin. */
export function oauthStartUrl(provider: ProviderId, returnTo: string): string {
  return `/api/integrations/${encodeURIComponent(provider)}/oauth/start?returnTo=${encodeURIComponent(returnTo)}`
}

export function integrationsReturnTo(locale: string): string {
  return `/${locale}?panel=settings&section=integrations`
}

const ERROR_KEYS: Record<IntegrationErrorCode, IntegrationsMessageKey> = {
  denied: "integrationsErrorDenied",
  invalid_state: "integrationsErrorInvalidState",
  expired_state: "integrationsErrorExpiredState",
  forbidden: "integrationsErrorForbidden",
  provider_mismatch: "integrationsErrorProviderMismatch",
  not_configured: "integrationsErrorNotConfigured",
  exchange_failed: "integrationsErrorExchangeFailed",
  tenant_not_allowed: "integrationsErrorTenantNotAllowed",
  cap_reached: "integrationsErrorCapReached",
  unknown: "integrationsErrorUnknown",
}

/** `?integration_error=` → a localized message key; unknown values map to the generic one. */
export function integrationErrorKey(code: string | null | undefined): IntegrationsMessageKey | null {
  if (!code) return null

  return (INTEGRATION_ERROR_CODES as readonly string[]).includes(code)
    ? ERROR_KEYS[code as IntegrationErrorCode]
    : "integrationsErrorUnknown"
}

/**
 * Reads and strips `integration_error` from a URL (path + search + hash),
 * keeping every other parameter. Returns `null` when the param is absent.
 */
export function takeIntegrationError(href: string): { code: string; cleanHref: string } | null {
  const url = new URL(href, "http://localhost")
  const code = url.searchParams.get("integration_error")

  if (code === null) return null
  url.searchParams.delete("integration_error")

  return { code, cleanHref: `${url.pathname}${url.search}${url.hash}` }
}

/** Per-provider config keys the PATCH route accepts (A2 allowlist). */
export const CONFIG_ALLOWLIST: Record<ProviderId, readonly string[]> = {
  slack: ["defaultChannelId", "defaultChannelName", "allowManualSend"],
  notion: ["defaultDatabaseId", "defaultDatabaseTitle", "allowManualSend"],
  hubspot: ["defaultDealId", "defaultDealName", "allowManualSend"],
  microsoft: ["calendarSyncEnabled"],
  google_drive: [],
}

/** Drops every config key the provider's PATCH allowlist doesn't accept. */
export function pickConfig(provider: ProviderId, patch: Record<string, unknown>): Record<string, unknown> {
  const allowed = CONFIG_ALLOWLIST[provider]

  return Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)))
}

export function allowsManualSend(connection: IntegrationConnectionDTO): boolean {
  return connection.config.allowManualSend !== false
}

export type DefaultDestination = { picker: string; idKey: string; labelKey: string; labelMessage: IntegrationsMessageKey }

export const DEFAULT_DESTINATIONS: Partial<Record<ProviderId, DefaultDestination>> = {
  slack: { picker: "channels", idKey: "defaultChannelId", labelKey: "defaultChannelName", labelMessage: "integrationsDefaultChannel" },
  notion: { picker: "databases", idKey: "defaultDatabaseId", labelKey: "defaultDatabaseTitle", labelMessage: "integrationsDefaultDatabase" },
  hubspot: { picker: "deals", idKey: "defaultDealId", labelKey: "defaultDealName", labelMessage: "integrationsDefaultDeal" },
}

export type OutlookSyncStats = { at?: string; events?: number; meetings?: number; errors?: number }

/** `config.lastSync` (Microsoft, counts only), tolerant of missing fields. */
export function outlookSyncStats(connection: IntegrationConnectionDTO | undefined): OutlookSyncStats | undefined {
  const raw = connection?.config.lastSync

  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>
  const num = (input: unknown) => (typeof input === "number" && Number.isFinite(input) ? input : undefined)

  return {
    at: typeof value.at === "string" ? value.at : undefined,
    events: num(value.events),
    meetings: num(value.meetings),
    errors: num(value.errors),
  }
}

// ---------------------------------------------------------------------------
// Rules

export const RULE_PROVIDERS_WITH_CONNECTION = ["slack", "notion", "hubspot"] as const

export const TRIGGER_KEYS: Record<RuleTrigger, IntegrationsMessageKey> = {
  "meeting.completed": "integrationsRuleTriggerMeetingCompleted",
  "summary.created": "integrationsRuleTriggerSummaryCreated",
  "action_item.created": "integrationsRuleTriggerActionItemCreated",
}

export function defaultRuleContent(): RuleContent {
  return { overview: true, actionItems: true, decisions: true, openQuestions: false, transcript: false, link: "app" }
}

export type DomainMode = "none" | "any_external" | "includes" | "excludes"

/** Editor state. Lists are kept as arrays; domains as free text until saved. */
export type RuleDraft = {
  id?: string
  provider: Exclude<RuleProviderId, "email">
  connectionId: string
  name: string
  enabled: boolean
  trigger: RuleTrigger
  roomIds: string[]
  tagNames: string[]
  domainMode: DomainMode
  domainsText: string
  visibility: MeetingVisibility[]
  languages: string[]
  sources: string[]
  minDurationMinutes: string
  destination: RuleDestination
  content: RuleContent
  includePrivate: boolean
}

export function emptyDestination(provider: Exclude<RuleProviderId, "email">): RuleDestination {
  if (provider === "slack") return { provider, channelId: "", channelName: "" }
  if (provider === "notion") return { provider, databaseId: "", databaseTitle: "" }

  return { provider, logAs: "meeting", createTasks: true, createMissingContacts: false, matchInternal: false }
}

export function emptyRuleDraft(connection: Pick<IntegrationConnectionDTO, "id" | "provider" | "config">): RuleDraft {
  const provider = connection.provider as RuleDraft["provider"]
  const destination = emptyDestination(provider)
  const config = connection.config

  // Prefill the connection's default destination when it has one.
  if (destination.provider === "slack" && typeof config.defaultChannelId === "string") {
    destination.channelId = config.defaultChannelId
    destination.channelName = typeof config.defaultChannelName === "string" ? config.defaultChannelName : config.defaultChannelId
  }
  if (destination.provider === "notion" && typeof config.defaultDatabaseId === "string") {
    destination.databaseId = config.defaultDatabaseId
    destination.databaseTitle =
      typeof config.defaultDatabaseTitle === "string" ? config.defaultDatabaseTitle : config.defaultDatabaseId
  }
  if (destination.provider === "hubspot" && typeof config.defaultDealId === "string") {
    destination.dealId = config.defaultDealId
    destination.dealName = typeof config.defaultDealName === "string" ? config.defaultDealName : config.defaultDealId
  }

  return {
    provider,
    connectionId: connection.id,
    name: "",
    enabled: true,
    trigger: "meeting.completed",
    roomIds: [],
    tagNames: [],
    domainMode: "none",
    domainsText: "",
    visibility: ["workspace", "link"],
    languages: [],
    sources: [],
    minDurationMinutes: "",
    destination,
    content: defaultRuleContent(),
    includePrivate: false,
  }
}

/**
 * Editing a rule someone else created resets `include_private` on save
 * (Model → Rules), so the draft shows it off for anyone but its creator.
 */
export function draftFromRule(rule: IntegrationRuleDTO, currentUserId: string | undefined): RuleDraft {
  const filters = rule.filters ?? {}
  const domains = filters.participantDomains

  return {
    id: rule.id,
    provider: rule.provider as RuleDraft["provider"],
    connectionId: rule.connectionId ?? "",
    name: rule.name,
    enabled: rule.enabled,
    trigger: rule.trigger,
    roomIds: filters.roomIds ?? [],
    tagNames: filters.tagNames ?? [],
    domainMode: domains?.mode ?? "none",
    domainsText: (domains?.domains ?? []).join(", "),
    visibility: filters.visibility ?? ["workspace", "link"],
    languages: filters.languages ?? [],
    sources: filters.sources ?? [],
    minDurationMinutes: filters.minDurationMinutes === undefined ? "" : String(filters.minDurationMinutes),
    destination: rule.destination,
    content: { ...defaultRuleContent(), ...rule.content },
    includePrivate: Boolean(currentUserId) && rule.createdByUserId === currentUserId ? rule.includePrivate : false,
  }
}

/** Splits free text into lowercased, de-duplicated domains (strips `@` and spaces). */
export function parseDomains(text: string): string[] {
  const out: string[] = []

  for (const part of text.split(/[\s,;]+/)) {
    const domain = part.trim().toLowerCase().replace(/^@+/, "")

    if (domain && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) && !out.includes(domain)) out.push(domain)
  }

  return out
}

export type RuleDraftErrors = Partial<Record<"name" | "destination" | "domains" | "minDuration", IntegrationsMessageKey>>

export function destinationComplete(destination: RuleDestination): boolean {
  if (destination.provider === "slack") return Boolean(destination.channelId)
  if (destination.provider === "notion") return Boolean(destination.databaseId)

  return true
}

export function validateRuleDraft(draft: RuleDraft): RuleDraftErrors {
  const errors: RuleDraftErrors = {}

  if (!draft.name.trim()) errors.name = "integrationsRuleValidationName"
  if (!draft.connectionId || !destinationComplete(draft.destination)) {
    errors.destination = "integrationsRuleValidationDestination"
  }
  if ((draft.domainMode === "includes" || draft.domainMode === "excludes") && parseDomains(draft.domainsText).length === 0) {
    errors.domains = "integrationsRuleFilterDomains"
  }
  if (draft.minDurationMinutes.trim()) {
    const minutes = Number(draft.minDurationMinutes)

    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) errors.minDuration = "integrationsRuleFilterMinDuration"
  }

  return errors
}

export type RuleRequest = {
  provider: RuleProviderId
  connectionId: string | null
  name: string
  enabled: boolean
  trigger: RuleTrigger
  filters: RuleFilters
  destination: RuleDestination
  content: RuleContent
  includePrivate: boolean
}

/** The POST/PATCH body for `/api/integrations/rules` (A3). Empty filters are omitted. */
export function ruleRequestFromDraft(draft: RuleDraft): RuleRequest {
  const filters: RuleFilters = {}

  if (draft.roomIds.length) filters.roomIds = [...draft.roomIds]
  if (draft.tagNames.length) filters.tagNames = [...draft.tagNames]
  if (draft.domainMode === "any_external") filters.participantDomains = { mode: "any_external", domains: [] }
  if (draft.domainMode === "includes" || draft.domainMode === "excludes") {
    filters.participantDomains = { mode: draft.domainMode, domains: parseDomains(draft.domainsText) }
  }
  if (draft.visibility.length) filters.visibility = [...draft.visibility]
  if (draft.languages.length) filters.languages = [...draft.languages]
  if (draft.sources.length) filters.sources = [...draft.sources]
  if (draft.minDurationMinutes.trim()) filters.minDurationMinutes = Number(draft.minDurationMinutes)

  return {
    provider: draft.provider,
    connectionId: draft.connectionId,
    name: draft.name.trim(),
    enabled: draft.enabled,
    trigger: draft.trigger,
    filters,
    destination: draft.destination,
    content: draft.content,
    includePrivate: draft.includePrivate,
  }
}

export function rulesUsingConnection(rules: readonly IntegrationRuleDTO[], connectionId: string): IntegrationRuleDTO[] {
  return rules.filter((rule) => rule.connectionId === connectionId && rule.enabled)
}

export function ruleDisabledKey(rule: IntegrationRuleDTO): IntegrationsMessageKey | null {
  if (rule.enabled) return null
  if (rule.disabledReason === "connection_revoked") return "integrationsRuleDisabledConnectionRevoked"
  if (rule.disabledReason === "rule_owner_inactive") return "integrationsRuleDisabledOwnerInactive"

  return "integrationsRuleDisabled"
}

/** A one-line, content-free description of where a rule sends. */
export function destinationLabel(destination: RuleDestination): string {
  if (destination.provider === "slack") return destination.channelName ? `#${destination.channelName.replace(/^#/, "")}` : ""
  if (destination.provider === "notion") return destination.databaseTitle
  if (destination.provider === "hubspot") return destination.dealName ?? ""

  return ""
}

// ---------------------------------------------------------------------------
// Email recap (A10: the singleton `email` rule)

export type EmailRecapMode = "off" | "all_meetings" | "opt_in"

export type EmailRecapDraft = {
  mode: EmailRecapMode
  audience: "members" | "attendees"
  locale: "meeting" | "he" | "en"
  content: RuleContent
}

export function findEmailRule(rules: readonly IntegrationRuleDTO[]) {
  return rules.find((rule) => rule.provider === "email")
}

export function emailRecapDraft(rule: IntegrationRuleDTO | undefined): EmailRecapDraft {
  const destination = rule?.destination.provider === "email" ? rule.destination : undefined

  return {
    mode: rule && rule.enabled && destination ? destination.mode : "off",
    audience: destination?.audience ?? "members",
    locale: destination?.locale ?? "meeting",
    content: { ...defaultRuleContent(), ...(rule?.content ?? {}) },
  }
}

/**
 * The request for the email rule: `off` disables an existing rule (or needs
 * nothing when there is none); otherwise an upsert via POST.
 */
export function emailRecapRequest(
  draft: EmailRecapDraft,
  existing: IntegrationRuleDTO | undefined
): { method: "POST"; body: RuleRequest } | { method: "PATCH"; id: string; body: Partial<RuleRequest> } | null {
  if (draft.mode === "off") {
    return existing ? { method: "PATCH", id: existing.id, body: { enabled: false } } : null
  }

  const body: RuleRequest = {
    provider: "email",
    connectionId: null,
    name: existing?.name ?? "Email recap",
    enabled: true,
    trigger: "meeting.completed",
    filters: existing?.filters ?? {},
    destination: { provider: "email", audience: draft.audience, mode: draft.mode, locale: draft.locale },
    content: draft.content,
    includePrivate: false,
  }

  return existing ? { method: "PATCH", id: existing.id, body } : { method: "POST", body }
}

// ---------------------------------------------------------------------------
// Deliveries

export const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  "queued",
  "running",
  "retrying",
  "sent",
  "partial",
  "skipped",
  "failed",
  "cancelled",
]

export const DELIVERY_STATUS_KEYS: Record<DeliveryStatus, IntegrationsMessageKey> = {
  queued: "integrationsStatusQueued",
  running: "integrationsStatusRunning",
  retrying: "integrationsStatusRetrying",
  sent: "integrationsStatusSent",
  partial: "integrationsStatusPartial",
  skipped: "integrationsStatusSkipped",
  failed: "integrationsStatusFailed",
  cancelled: "integrationsStatusCancelled",
}

const SKIP_KEYS: Partial<Record<DeliverySkipReason, IntegrationsMessageKey>> = {
  private_meeting: "integrationsSkipPrivateMeeting",
  rule_owner_inactive: "integrationsSkipRuleOwnerInactive",
  filtered: "integrationsSkipFiltered",
  recap_off: "integrationsSkipRecapOff",
  needs_reauth: "integrationsSkipNeedsReauth",
  hourly_cap: "integrationsSkipHourlyCap",
  recap_not_opted_in: "integrationsSkipNotOptedIn",
  no_recipients: "integrationsSkipNoRecipients",
  connection_inactive: "integrationsSkipConnectionInactive",
  no_crm_target: "integrationsSkipNoCrmTarget",
  unchanged: "integrationsSkipUnchanged",
  manual_send_disabled: "integrationsSkipManualSendDisabled",
}

const ERROR_KIND_KEYS: Record<string, IntegrationsMessageKey> = {
  auth: "integrationsErrorKindAuth",
  forbidden: "integrationsErrorKindForbidden",
  not_found: "integrationsErrorKindNotFound",
  invalid: "integrationsErrorKindInvalid",
  rate_limited: "integrationsErrorKindRateLimited",
  retryable: "integrationsErrorKindRetryable",
  config: "integrationsErrorKindConfig",
}

/**
 * A stored delivery error (`code=… kind=<kind> …`) as a localized message
 * key: the UI never shows the raw typed string.
 */
export function deliveryErrorKey(lastError: string | undefined): IntegrationsMessageKey | null {
  if (!lastError) return null

  const kind = /\bkind=([a-z_]+)/.exec(lastError)?.[1]

  return (kind && ERROR_KIND_KEYS[kind]) || "integrationsErrorKindRetryable"
}

const HINT_KEYS: Record<string, IntegrationsMessageKey> = {
  not_member: "integrationsHintNotMember",
  private: "integrationsHintPrivateChannel",
  // HubSpot default pipeline stage ids.
  appointmentscheduled: "integrationsDealStageAppointmentScheduled",
  qualifiedtobuy: "integrationsDealStageQualifiedToBuy",
  presentationscheduled: "integrationsDealStagePresentationScheduled",
  decisionmakerboughtin: "integrationsDealStageDecisionMakerBoughtIn",
  contractsent: "integrationsDealStageContractSent",
  closedwon: "integrationsDealStageClosedWon",
  closedlost: "integrationsDealStageClosedLost",
}

/** A picker hint code (`not_member`, a HubSpot stage id) as a message key; null hides an unknown code. */
export function pickerHintKey(hint: string | undefined): IntegrationsMessageKey | null {
  return hint ? (HINT_KEYS[hint.toLowerCase()] ?? null) : null
}

const SOURCE_KEYS: Record<string, IntegrationsMessageKey> = {
  google_meet: "integrationsSourceGoogleMeet",
  teams: "integrationsSourceTeams",
  zoom: "integrationsSourceZoom",
  meeting_bot: "integrationsSourceMeetingBot",
  outlook_calendar: "integrationsSourceOutlookCalendar",
  upload: "integrationsSourceUpload",
  pwa_recorder: "integrationsSourcePwaRecorder",
  desktop_recorder: "integrationsSourceDesktopRecorder",
}

/** A meeting source (rule filter checkbox) as a message key. */
export function sourceLabelKey(source: string): IntegrationsMessageKey | null {
  return SOURCE_KEYS[source] ?? null
}

/** The manual-send error code as a message key (generic "failed" otherwise). */
export function sendErrorKey(code: string | undefined): IntegrationsMessageKey {
  if (code === "private_meeting_not_opted_in") return "integrationsSendPrivateNotOptedIn"
  if (code === "queue_unavailable") return "integrationsSendQueueUnavailable"
  return "integrationsStatusFailed"
}

/** The skip reason's message key, or `integrationsSkipOther` (rendered with `{reason}`). */
export function skipReasonKey(reason: string | undefined): IntegrationsMessageKey | null {
  if (!reason) return null

  return SKIP_KEYS[reason as DeliverySkipReason] ?? "integrationsSkipOther"
}

/** A7: retry is allowed for failed, partial, or skipped because the connection needed reauth. */
export function isDeliveryRetryable(delivery: Pick<IntegrationDeliveryDTO, "status" | "skipReason">): boolean {
  return (
    delivery.status === "failed" ||
    delivery.status === "partial" ||
    (delivery.status === "skipped" && delivery.skipReason === "needs_reauth")
  )
}

export function isTerminalDelivery(status: DeliveryStatus): boolean {
  return status === "sent" || status === "partial" || status === "skipped" || status === "failed" || status === "cancelled"
}

/** Only failures get a pill; everything else is plain text. */
export function deliveryPill(status: string): "failed" | "review" | null {
  if (status === "failed") return "failed"
  if (status === "partial") return "review"

  return null
}

/** `meetingTitle: null` means the viewer can't see it → "Private meeting". */
export function deliveryMeetingLabel(
  delivery: Pick<IntegrationDeliveryDTO, "meetingTitle" | "meetingId">,
  privateLabel: string
): { text: string; isPrivate: boolean } | null {
  if (!delivery.meetingId) return null
  if (delivery.meetingTitle === null || delivery.meetingTitle === undefined) return { text: privateLabel, isPrivate: true }

  return { text: delivery.meetingTitle, isPrivate: false }
}

/** An https URL from `externalRef` (permalink, url), never anything else. */
export function deliveryExternalUrl(delivery: Pick<IntegrationDeliveryDTO, "status" | "externalRef">): string | undefined {
  if (delivery.status !== "sent" && delivery.status !== "partial") return undefined

  for (const key of ["permalink", "url"]) {
    const value = delivery.externalRef?.[key]

    if (typeof value === "string" && /^https:\/\//i.test(value)) return value
  }

  return undefined
}

export type DeliveryFilters = { status?: string; provider?: string; ruleId?: string; meetingId?: string }

export function deliveriesQuery(filters: DeliveryFilters, cursor?: string, limit = 25): string {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
  if (cursor) params.set("before", cursor)
  params.set("limit", String(limit))

  return params.toString()
}

// ---------------------------------------------------------------------------
// Webhooks

export type WebhookPayloadVersion = 1 | 2

export type CatalogEvent = {
  name: string
  versions: number[]
  description?: string
  example?: unknown
  schemaUrl?: string
}

/** Events a subscription of `version` may subscribe to. */
export function catalogEventsFor(events: readonly CatalogEvent[], version: WebhookPayloadVersion): CatalogEvent[] {
  return events.filter((event) => event.versions.includes(version))
}

export function canUpgradeWebhook(subscription: { payloadVersion?: number }): boolean {
  return (subscription.payloadVersion ?? 1) < 2
}

/** Existing webhook deliveries API: `failed` and `cancelled` can be retried. */
export function isWebhookDeliveryRetryable(status: string): boolean {
  return status === "failed" || status === "cancelled"
}

// ---------------------------------------------------------------------------
// Per-meeting controls (D2)

export function meetingControlsState(params: {
  visibility: MeetingVisibility | undefined
  isOwner: boolean
  canManage: boolean
  canWrite: boolean
  emailRecapAvailable: boolean
}) {
  // Unknown visibility is treated as private (privacy gate).
  const isPrivate = params.visibility !== "workspace" && params.visibility !== "link"

  return {
    isPrivate,
    /** Owner only, private meetings only. */
    showAllowPrivate: isPrivate && params.isOwner,
    showEmailRecap: params.emailRecapAvailable,
    canEditEmailRecap: params.canWrite && (!isPrivate || params.canManage),
    /** A6: visible + meeting:write; private → canManageMeeting. */
    canSend: params.canWrite && (!isPrivate || params.canManage),
  }
}

/** Active workspace connections that accept manual sends. */
export function manualSendTargets(connections: readonly IntegrationConnectionDTO[]): IntegrationConnectionDTO[] {
  return connections.filter(
    (connection) => isWorkspaceProvider(connection.provider) && connection.status === "active" && allowsManualSend(connection)
  )
}

export function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID()

  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

// ---------------------------------------------------------------------------
// Formatting

/** Locale-aware date/time (`he-IL` for Hebrew). Returns "" for missing or invalid input. */
export function formatWhen(locale: string, iso: string | undefined | null): string {
  if (!iso) return ""
  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) return ""

  return new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(date)
}

export function directionFor(locale: string): "rtl" | "ltr" {
  return locale === "he" ? "rtl" : "ltr"
}
