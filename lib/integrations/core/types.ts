/**
 * M8 shared integration contracts (docs/parity/m8.md, "Shared contracts").
 * Written in Step 0 and FROZEN afterwards: packages A–D import each other
 * only through these types; changes go through the orchestrator.
 *
 * No type here carries a token except `TokenSet`, which never leaves
 * `lib/integrations/core/tokens.ts` and the provider OAuth helpers.
 */
import type { MeetingRecap } from "@/lib/integrations/recap"
import type { MeetingRecord, MeetingVisibility } from "@/lib/meetings/repository"

// ---------------------------------------------------------------------------
// Providers and connections

/** OAuth providers with a connection row. */
export type ProviderId = "slack" | "microsoft" | "notion" | "hubspot" | "google_drive"
/** Providers a rule can target (`email` has no connection). */
export type RuleProviderId = "slack" | "notion" | "hubspot" | "email"
/** Workspace-level connections (`user_id` null; admins manage them). */
export type WorkspaceProviderId = "slack" | "notion" | "hubspot"
/** Personal connections (`user_id` = the owner; `integrations:connect`). */
export type PersonalProviderId = "microsoft" | "google_drive"

export const PROVIDER_IDS = ["slack", "microsoft", "notion", "hubspot", "google_drive"] as const satisfies readonly ProviderId[]
export const WORKSPACE_PROVIDER_IDS = ["slack", "notion", "hubspot"] as const satisfies readonly WorkspaceProviderId[]
export const PERSONAL_PROVIDER_IDS = ["microsoft", "google_drive"] as const satisfies readonly PersonalProviderId[]

export type ConnectionStatus = "active" | "needs_reauth" | "revoked" | "error"

/**
 * A connection as the API returns it. Never contains a token or a `*_enc`
 * value (a type test asserts it). `lastError` is already redacted.
 */
export type IntegrationConnectionDTO = {
  id: string
  provider: ProviderId
  status: ConnectionStatus
  accountLabel: string
  scopes: string[]
  expiresAt?: string
  /** Set for personal connections only. */
  userId?: string
  createdByUserId?: string
  createdAt: string
  lastUsedAt?: string
  lastError?: string
  /** Non-secret per-provider config (defaultChannelId, allowManualSend, lastSync…). */
  config: Record<string, unknown>
  /** True when the server runs against the dev/e2e fake providers. */
  fake?: boolean
}

/** OAuth token material. Server-only; never serialized to a client, log or job. */
export type TokenSet = {
  accessToken: string
  refreshToken?: string
  /** ISO timestamp. */
  expiresAt?: string
  tokenType?: string
  scopes: string[]
}

/** `GET /api/integrations/providers` row (never includes client ids). */
export type ProviderInfo = {
  id: ProviderId | "email"
  scope: "workspace" | "user" | "none"
  configured: boolean
  fake: boolean
}

// ---------------------------------------------------------------------------
// Errors

export type ProviderErrorKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "rate_limited"
  | "retryable"
  | "config"

/**
 * Error raised by provider calls. `message` must already be redacted
 * (`redactIntegrationError`); it is never reflected to clients as-is.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind
  readonly retryAfterMs?: number
  readonly providerCode?: string

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { retryAfterMs?: number; providerCode?: string; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "ProviderError"
    this.kind = kind
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
    if (options.providerCode !== undefined) this.providerCode = options.providerCode
  }
}

/** Fixed `?integration_error=<code>` values for the OAuth redirect (never provider text). */
export const INTEGRATION_ERROR_CODES = [
  "denied",
  "invalid_state",
  "expired_state",
  "forbidden",
  "provider_mismatch",
  "not_configured",
  "exchange_failed",
  "tenant_not_allowed",
  "cap_reached",
  "unknown",
] as const
export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number]

// ---------------------------------------------------------------------------
// Rules

export type RuleTrigger = "meeting.completed" | "summary.created" | "action_item.created"
export const RULE_TRIGGERS = ["meeting.completed", "summary.created", "action_item.created"] as const satisfies readonly RuleTrigger[]

/** All optional and AND-ed. */
export type RuleFilters = {
  /** Meeting contexts (rooms). */
  roomIds?: string[]
  /** Any match. */
  tagNames?: string[]
  /** Internal domains: member email domains plus MEETSUM_BOT_INTERNAL_DOMAINS (M7). */
  participantDomains?: {
    mode: "any_external" | "includes" | "excludes"
    domains: string[]
  }
  /** Default `["workspace", "link"]`. */
  visibility?: MeetingVisibility[]
  languages?: string[]
  sources?: string[]
  minDurationMinutes?: number
}

export type RuleContent = {
  overview: boolean
  actionItems: boolean
  decisions: boolean
  openQuestions: boolean
  transcript: boolean
  /** A rule never creates a share link (that would flip visibility to `link`). */
  link: "app" | "existing_share" | "none"
}

export type RuleDestination =
  | { provider: "slack"; channelId: string; channelName: string }
  | { provider: "notion"; databaseId: string; databaseTitle: string; titleProperty?: string }
  | {
      provider: "hubspot"
      dealId?: string
      dealName?: string
      logAs: "meeting" | "note"
      createTasks: boolean
      createMissingContacts: boolean
      matchInternal: boolean
    }
  | {
      provider: "email"
      /** `attendees` needs an explicit admin choice and never applies to private meetings. */
      audience: "members" | "attendees"
      mode: "all_meetings" | "opt_in"
      locale: "meeting" | "he" | "en"
    }

export type IntegrationRuleDTO = {
  id: string
  provider: RuleProviderId
  /** Null for `email`. */
  connectionId: string | null
  name: string
  enabled: boolean
  trigger: RuleTrigger
  filters: RuleFilters
  destination: RuleDestination
  content: RuleContent
  /** Honoured only for meetings the rule creator owns. */
  includePrivate: boolean
  createdByUserId?: string
  /** e.g. `connection_revoked`, `rule_owner_inactive`. */
  disabledReason?: string
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Deliveries

export type DeliveryStatus =
  | "queued"
  | "running"
  | "retrying"
  | "sent"
  | "partial"
  | "skipped"
  | "failed"
  | "cancelled"

export type DeliveryOrigin = "rule" | "manual"

export type DeliverySkipReason =
  | "private_meeting"
  | "rule_owner_inactive"
  | "filtered"
  | "recap_off"
  | "recap_not_opted_in"
  | "needs_reauth"
  | "connection_inactive"
  | "manual_send_disabled"
  | "no_recipients"
  | "hourly_cap"
  | "no_crm_target"
  | "unchanged"
  | "meeting_not_found"

export type IntegrationDeliveryDTO = {
  id: string
  ruleId?: string
  connectionId?: string
  provider: RuleProviderId | ProviderId
  origin: DeliveryOrigin
  eventName?: string
  meetingId?: string
  /** Only when the meeting is visible to the viewer; `null` → "Private meeting". */
  meetingTitle?: string | null
  actionItemId?: string
  status: DeliveryStatus
  skipReason?: DeliverySkipReason
  attempts: number
  maxAttempts: number
  /** Identifiers and URLs only, never content. */
  externalRef: Record<string, unknown>
  /** Redacted, ≤ 500 characters. */
  lastError?: string
  requestedByUserId?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

// ---------------------------------------------------------------------------
// Pickers, meeting facts and prefs

export type PickerItem = { id: string; label: string; hint?: string }
export type PickerPage = { items: PickerItem[]; nextCursor?: string }

/** What the dispatcher evaluates rules and the privacy gate against. */
export type MeetingFacts = {
  meetingId: string
  workspaceId: string
  /** Unknown visibility is treated as private. */
  visibility: MeetingVisibility | undefined
  ownerUserId?: string
  contextIds: string[]
  tagNames: string[]
  participantEmails: string[]
  language: string
  source: string
  durationMs?: number
}

export type EmailRecapPreference = "inherit" | "on" | "off"

export type MeetingIntegrationPrefs = {
  meetingId: string
  workspaceId: string
  /** Owner-only opt-in; honoured only when `allowPrivateSetByUserId` is the owner. */
  allowPrivatePush: boolean
  allowPrivateSetByUserId?: string
  emailRecap: EmailRecapPreference
  updatedByUserId?: string
  updatedAt?: string
}

// ---------------------------------------------------------------------------
// Provider plumbing

/** Outbound provider HTTP (`providerFetch` in core/http.ts implements it). */
export type ProviderFetch = (provider: ProviderId, url: string, init?: RequestInit) => Promise<Response>

export type IntegrationObjectKind =
  | "slack_message"
  | "notion_page"
  | "hubspot_engagement"
  | "hubspot_task"
  | "google_doc"

export type IntegrationLink = {
  id: string
  connectionId: string
  provider: ProviderId
  meetingId: string
  objectKind: IntegrationObjectKind
  destinationKey: string
  /** `""` unless `objectKind` is `hubspot_task`. */
  actionItemId: string
  externalId: string
  externalUrl?: string
  contentHash?: string
  createdAt: string
  updatedAt: string
}

export type IntegrationLinkKey = {
  objectKind: IntegrationObjectKind
  destinationKey?: string
  actionItemId?: string
}

/** Workspace- and connection-scoped link store handed to providers. */
export type LinkStore = {
  get(key: IntegrationLinkKey): Promise<IntegrationLink | undefined>
  list(objectKind: IntegrationObjectKind, destinationKey?: string): Promise<IntegrationLink[]>
  upsert(
    key: IntegrationLinkKey & { externalId: string; externalUrl?: string; contentHash?: string }
  ): Promise<IntegrationLink>
  remove(key: IntegrationLinkKey): Promise<void>
}

/** What a provider receives for tests, pickers and destination checks. */
export type ProviderCtx = {
  workspaceId: string
  connection: IntegrationConnectionDTO
  getAccessToken(): Promise<string>
  fetch: ProviderFetch
}

/** `progress` checkpoint: ids and hashes only. */
export type DeliveryProgress = Record<string, unknown>

export type DeliverInput = {
  workspaceId: string
  delivery: IntegrationDeliveryDTO
  /** Absent for `email`. */
  connection?: IntegrationConnectionDTO
  getAccessToken(): Promise<string>
  rule?: IntegrationRuleDTO
  destination: RuleDestination
  content: RuleContent
  recap: MeetingRecap
  meeting: MeetingRecord
  progress: DeliveryProgress
  saveProgress(progress: DeliveryProgress): Promise<void>
  links: LinkStore
  fetch: ProviderFetch
}

export type DeliverResult = {
  status: "sent" | "partial" | "skipped"
  skipReason?: DeliverySkipReason
  /** Identifiers and URLs only. */
  externalRef: Record<string, unknown>
  progress?: DeliveryProgress
}

export type OAuthExchangeResult = TokenSet & {
  account: { externalId: string; label: string }
  config?: Record<string, unknown>
}

/** A request recorded by the dev/e2e fake provider server (tokens redacted). */
export type FakeProviderRequest = {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: unknown
}

export type FakeProviderResponse = {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  /** For the fake authorize page: redirect target. */
  redirect?: string
}

/** `"<METHOD> <path>"` → handler, served by `createFakeProviderServer`. */
export type FakeProviderHandlers = Record<
  string,
  (request: FakeProviderRequest) => FakeProviderResponse | Promise<FakeProviderResponse>
>

export type ProviderJob = {
  everyMinutes: number
  run(params: { workspaceId: string; connectionId: string }): Promise<unknown>
}

export interface IntegrationProvider {
  id: ProviderId | "email"
  scope: "workspace" | "user" | "none"
  configured(env?: NodeJS.ProcessEnv): boolean
  oauth?: {
    pkce: boolean
    scopes: string[]
    optionalScopes?: string[]
    authorizeUrl(params: { state: string; redirectUri: string; codeChallenge?: string }): string
    exchangeCode(code: string, params: { redirectUri: string; codeVerifier?: string }): Promise<OAuthExchangeResult>
    refresh?(refreshToken: string): Promise<TokenSet>
    revoke?(tokens: TokenSet): Promise<void>
  }
  /** A no-op call for "Test connection". */
  test?(ctx: ProviderCtx): Promise<void>
  pickers?: Record<string, (ctx: ProviderCtx, query: { query?: string; cursor?: string }) => Promise<PickerPage>>
  validateDestination?(destination: RuleDestination, ctx: ProviderCtx): Promise<void>
  deliver?(input: DeliverInput): Promise<DeliverResult>
  jobs?: Record<string, ProviderJob>
  /** Routes for the dev/e2e fake server. */
  fake?: FakeProviderHandlers
}
