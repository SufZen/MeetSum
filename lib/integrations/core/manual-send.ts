/**
 * The checks every manual push runs before anything reaches a provider
 * (docs/parity/m8.md, "Privacy gate" and A6). One function shared by
 * `POST /api/meetings/:id/integrations/send` and the synchronous export
 * routes (Notion, Google Docs), so the paths cannot drift apart:
 *
 *  1. the connection is active (else 409 `integration_needs_reauth`);
 *  2. `config.allowManualSend !== false` (else 403 `manual_send_disabled`);
 *  3. the destination targets the connection's provider;
 *  4. the single privacy gate (`evaluatePrivacyGate`, origin `manual`): a
 *     private meeting needs the owner's per-meeting opt-in, whoever sends it
 *     (else 403 `private_meeting_not_opted_in`);
 *  5. the destination is checked with the provider (`validateDestination`,
 *     when the caller passes it): a rejected destination → 400
 *     `invalid_destination`; a provider outage or rate limit is returned as
 *     `providerError` for the caller's fixed mapping. A client-supplied
 *     destination the provider cannot verify is refused (400
 *     `destination_not_verifiable`); the connection default is not.
 *
 * Errors are fixed codes; provider text is never reflected.
 */
import { evaluatePrivacyGate } from "@/lib/integrations/core/privacy"
import {
  ProviderError,
  type ConnectionStatus,
  type MeetingIntegrationPrefs,
  type RuleDestination,
} from "@/lib/integrations/core/types"
import type { MeetingVisibility } from "@/lib/meetings/repository"

export type ManualPushDenied = {
  ok: false
  status: number
  code: string
  providerCode?: string
  /** Set when the provider was unavailable or rate limited while validating (callers map it). */
  providerError?: ProviderError
}
export type ManualPushCheck = { ok: true } | ManualPushDenied

export type ManualPushInput = {
  meeting: { visibility?: MeetingVisibility; ownerUserId?: string }
  /** Absent when the push does not use a connection (Google Docs DWD). */
  connection?: { provider: string; status: ConnectionStatus; config: Record<string, unknown> }
  /** Absent for exports without a destination id (Google Docs). */
  destination?: RuleDestination
  /** The destination came from the request body (not the connection default). */
  clientDestination?: boolean
  /** The provider's `validateDestination`, bound to this connection. */
  validate?: (destination: RuleDestination) => Promise<void>
  getPrefs(): Promise<Pick<MeetingIntegrationPrefs, "allowPrivatePush" | "allowPrivateSetByUserId"> | undefined>
  requestedByUserId?: string
}

function denied(status: number, code: string, providerCode?: string): ManualPushDenied {
  return { ok: false, status, code, ...(providerCode ? { providerCode } : {}) }
}

export async function checkManualPush(input: ManualPushInput): Promise<ManualPushCheck> {
  const { connection, destination } = input

  if (connection) {
    if (connection.status !== "active") return denied(409, "integration_needs_reauth")
    if (connection.config.allowManualSend === false) return denied(403, "manual_send_disabled")
  }
  if (destination && connection && destination.provider !== connection.provider) {
    return denied(400, "destination_provider_mismatch")
  }

  const prefs = await input.getPrefs()
  const privacy = evaluatePrivacyGate({
    facts: {
      visibility: input.meeting.visibility,
      ...(input.meeting.ownerUserId ? { ownerUserId: input.meeting.ownerUserId } : {}),
    },
    origin: "manual",
    ...(prefs ? { prefs } : {}),
    ...(input.requestedByUserId ? { requestedByUserId: input.requestedByUserId } : {}),
  })

  if (!privacy.allowed) return denied(403, "private_meeting_not_opted_in")

  if (destination) {
    if (input.validate) {
      try {
        await input.validate(destination)
      } catch (error) {
        if (error instanceof ProviderError && error.kind === "auth") return denied(409, "integration_needs_reauth")
        if (error instanceof ProviderError && (error.kind === "rate_limited" || error.kind === "retryable" || error.kind === "config")) {
          return { ...denied(error.kind === "rate_limited" ? 429 : 502, "provider_unavailable"), providerError: error }
        }

        const code = error instanceof ProviderError && /^[a-z_]{1,64}$/.test(error.providerCode ?? "") ? error.providerCode : undefined

        return denied(400, "invalid_destination", code)
      }
    } else if (input.clientDestination) {
      return denied(400, "destination_not_verifiable")
    }
  }

  return { ok: true }
}
