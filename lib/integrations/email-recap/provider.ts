/**
 * Email recap provider (docs/parity/m8.md A10): the singleton `email` rule,
 * trigger `meeting.completed`. Owner: Package A.
 *
 * - Off by default (no rule → nothing sent); per-meeting `email_recap`
 *   on/off is applied by the dispatcher and again at deliver time.
 * - Members only by default; `attendees` never applies to private meetings.
 * - One email per recipient (addresses are never exposed to each other).
 *   `progress.sent` holds sha256 hashes, so a retry never re-sends.
 *   Before each SMTP/Gmail call the recipient hash is written to
 *   `progress.pending` (its own write; a failure aborts before sending), and
 *   the result is written right after the send, separately. A retry treats
 *   a pending hash as already sent (at most once: a crash between the
 *   intent and the send loses that one email instead of duplicating it);
 *   `progress.sentLog` feeds the per-workspace hourly cap (DB-counted).
 * - Hourly cap hit → `rate_limited` (`hourly_cap`): the retry resumes when
 *   the window frees; the last attempt ends `partial`.
 * - Audit `email.recap.sent {meetingId, sent, skipped, failed}` (counts only).
 */
import { createHash } from "node:crypto"

import { getEmailSender } from "@/lib/email"
import { buildMeetingRecapEmail } from "@/lib/email/templates/meeting-recap"
import type { EmailSender } from "@/lib/email/types"
import { auditIntegration } from "@/lib/integrations/core/audit"
import { integrationLog, ProviderHttpError } from "@/lib/integrations/core/errors"
import { emailRecapMaxPerHour, emailRecapMaxRecipients } from "@/lib/integrations/core/limits"
import { recapLocale } from "@/lib/integrations/core/links"
import { getIntegrationStore, type IntegrationStore } from "@/lib/integrations/core/store"
import { ProviderError, type DeliverInput, type DeliverResult, type IntegrationProvider } from "@/lib/integrations/core/types"
import { resolveRecapRecipients } from "@/lib/integrations/email-recap/recipients"
import { signUnsubscribeToken, unsubscribeUrl } from "@/lib/integrations/email-recap/unsubscribe-token"
import { getTaskTimeZone } from "@/lib/tasks/time-zone"

export type EmailRecapDeps = {
  store?: () => Promise<IntegrationStore>
  sender?: () => EmailSender
  listMembers?: (workspaceId: string) => Promise<{ userId: string; email: string }[]>
  workspaceName?: (workspaceId: string) => Promise<string>
  /** Pause between sends (queue limiter: 5 emails/s). */
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
  env?: NodeJS.ProcessEnv
}

export function recipientHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex")
}

async function defaultMembers(workspaceId: string) {
  const { getWorkspaceStore } = await import("@/lib/workspaces/store")

  return (await getWorkspaceStore().listMembers(workspaceId)).map((member) => ({ userId: member.userId, email: member.user.email }))
}

async function defaultWorkspaceName(workspaceId: string) {
  const { getWorkspaceStore } = await import("@/lib/workspaces/store")

  return (await getWorkspaceStore().getWorkspace(workspaceId))?.name ?? "MeetSum"
}

export function createEmailRecapProvider(deps: EmailRecapDeps = {}): IntegrationProvider {
  const env = () => deps.env ?? process.env
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  async function deliver(input: DeliverInput): Promise<DeliverResult> {
    const destination = input.destination

    if (destination.provider !== "email") throw new ProviderHttpError("invalid", "email", 0, { providerCode: "invalid_destination" })

    const store = await (deps.store ?? getIntegrationStore)()
    const sender = (deps.sender ?? (() => getEmailSender(env())))()
    const now = deps.now ?? (() => new Date())
    const emails = (input.meeting.participantDetails ?? []).map((participant) => participant.email ?? "").filter(Boolean)
    const unsubscribed = await store.listUnsubscribed(input.workspaceId, emails)
    const members = await (deps.listMembers ?? defaultMembers)(input.workspaceId)
    const { recipients, excluded } = resolveRecapRecipients({
      meeting: input.meeting,
      members,
      unsubscribed,
      audience: destination.audience,
      botEmail: env().MEETSUM_BOT_ACCOUNT_EMAIL,
      max: emailRecapMaxRecipients(env()),
    })
    const skipped = Object.values(excluded).reduce((sum, value) => sum + value, 0)

    if (!recipients.length) {
      await audit(input, 0, skipped, 0)
      return { status: "skipped", skipReason: "no_recipients", externalRef: { recipients: 0 } }
    }

    const locale = destination.locale === "meeting" ? recapLocale(input.recap.language) : destination.locale
    const workspaceName = await (deps.workspaceName ?? defaultWorkspaceName)(input.workspaceId)
    const sent = new Set(Array.isArray(input.progress.sent) ? (input.progress.sent as string[]) : [])
    // A pending intent from an earlier attempt may have been sent: never re-send it.
    for (const hash of Array.isArray(input.progress.pending) ? (input.progress.pending as string[]) : []) sent.add(hash)
    const pending = new Set<string>()
    const sentLog = Array.isArray(input.progress.sentLog) ? [...(input.progress.sentLog as { at: string; n: number }[])] : []
    const failedHashes: string[] = []
    const hourAgo = new Date(now().getTime() - 60 * 60_000)
    let budget = emailRecapMaxPerHour(env()) - (await store.countRecapEmailsSince(input.workspaceId, hourAgo))
    let capped = false
    const snapshot = () => ({ ...input.progress, sent: [...sent], pending: [...pending], sentLog })

    for (const recipient of recipients) {
      const hash = recipientHash(recipient.email)

      if (sent.has(hash)) continue
      if (budget <= 0) {
        capped = true
        break
      }

      const message = buildMeetingRecapEmail({
        to: recipient.email,
        locale,
        recap: input.recap,
        workspaceName,
        ...(recipient.isMember && input.recap.links.meeting ? { appUrl: absolute(input.recap.links.meeting, env()) } : {}),
        ...(!recipient.isMember && input.content.link === "existing_share" && input.recap.links.share ? { shareUrl: input.recap.links.share } : {}),
        unsubscribeUrl: unsubscribeUrl(signUnsubscribeToken({ workspaceId: input.workspaceId, email: recipient.email }, env()), env(), locale),
        timeZone: getTaskTimeZone(env()),
      })

      // 1. Intent first (its own write): no write, no send.
      pending.add(hash)
      await input.saveProgress(snapshot())

      // 2. The external call, alone.
      try {
        await sender.send(message)
      } catch (error) {
        failedHashes.push(hash)
        integrationLog.warn("recap email send failed", error)
        pending.delete(hash)
        // Clear the intent so a retry sends it; if this write fails the
        // email is skipped rather than duplicated.
        await input.saveProgress(snapshot()).catch(() => undefined)
        await sleep(200)
        continue
      }

      // 3. The result, separately: a failed write leaves the pending intent,
      //    which a retry treats as sent.
      pending.delete(hash)
      sent.add(hash)
      sentLog.push({ at: now().toISOString(), n: 1 })
      budget -= 1
      await input.saveProgress(snapshot()).catch((error: unknown) => {
        pending.add(hash)
        integrationLog.warn("recap email progress write failed", error)
      })
      await sleep(200)
    }

    const progress = { ...input.progress, sent: [...sent], pending: [], sentLog }

    await audit(input, sent.size, skipped, failedHashes.length)

    if (capped) {
      const oldest = sentLog.map((entry) => Date.parse(entry.at)).filter((at) => at > hourAgo.getTime()).sort()[0]
      const retryAfterMs = oldest ? Math.max(60_000, oldest + 60 * 60_000 - now().getTime()) : 60 * 60_000

      throw new ProviderError("rate_limited", "email recap hourly cap reached", { retryAfterMs, providerCode: "hourly_cap" })
    }
    if (failedHashes.length) {
      throw new ProviderError("retryable", "some recap emails failed", { providerCode: "send_failed" })
    }

    return { status: "sent", externalRef: { recipients: sent.size }, progress }
  }

  return {
    id: "email",
    scope: "none",
    configured: (value = process.env) => getEmailSender(value).isConfigured(),
    // No external id to check: only the email destination shape is accepted.
    async validateDestination(destination) {
      if (destination.provider !== "email") throw new ProviderError("invalid", "destination is not email")
    },
    deliver,
  }
}

function absolute(url: string, env: NodeJS.ProcessEnv): string {
  if (/^https?:\/\//i.test(url)) return url

  const origin = (env.NEXT_PUBLIC_APP_URL?.trim() || "").replace(/\/+$/, "")

  return origin ? `${origin}${url}` : url
}

async function audit(input: DeliverInput, sent: number, skipped: number, failed: number) {
  await auditIntegration({ workspaceId: input.workspaceId, actor: "system:integrations" }, "email.recap.sent", {
    type: "meeting",
    id: input.meeting.id,
  }, { meetingId: input.meeting.id, sent, skipped, failed, deliveryId: input.delivery.id })
}

export const emailRecapProvider: IntegrationProvider = createEmailRecapProvider()
