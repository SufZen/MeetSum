import { botLog } from "@/lib/bot/redact"
import { type BotSessionStore, getBotSessionStore } from "@/lib/bot/store"
import type { BotConsentStatus, BotRules, BotSessionRecord } from "@/lib/bot/types"
import { getBotProvider } from "@/lib/bot/vexa/client"
import type { BotProvider } from "@/lib/bot/vexa/types"
import { getBotRules } from "@/lib/settings/bot-rules"

/**
 * Recording-consent chat message (M7 A8), sent by the `bot.consent` job on
 * the transition to `active`. Capability-probed: the client returns
 * `unsupported` on 404/405, and the UI then asks the host to announce the
 * recording. The bot name itself always signals recording (rules.ts).
 */

export const CONSENT_RETRIES = 2
const RETRY_DELAY_MS = 2_000

export type ConsentDeps = {
  store: BotSessionStore
  provider: () => BotProvider
  getRules: (workspaceId: string) => Promise<BotRules>
  getMeetingLanguage: (workspaceId: string, meetingId: string) => Promise<string | undefined>
  /** Requester's display name, else the workspace name. */
  getOwnerName: (session: BotSessionRecord) => Promise<string | undefined>
  sleep: (ms: number) => Promise<void>
}

async function defaultMeetingLanguage(workspaceId: string, meetingId: string) {
  const { getSystemMeetingRepository } = await import("@/lib/meetings/store")

  return (await getSystemMeetingRepository(workspaceId).getMeeting(meetingId))?.language
}

async function defaultOwnerName(session: BotSessionRecord): Promise<string | undefined> {
  const { getWorkspaceStore } = await import("@/lib/workspaces/store")
  const store = getWorkspaceStore()

  if (session.requestedByUserId) {
    const user = await store.getUserById(session.requestedByUserId)

    if (user?.name?.trim()) return user.name.trim()
  }

  return (await store.getWorkspace(session.workspaceId))?.name
}

function resolve(deps: Partial<ConsentDeps>): ConsentDeps {
  return {
    store: deps.store ?? getBotSessionStore(),
    provider: deps.provider ?? getBotProvider,
    getRules: deps.getRules ?? getBotRules,
    getMeetingLanguage: deps.getMeetingLanguage ?? defaultMeetingLanguage,
    getOwnerName: deps.getOwnerName ?? defaultOwnerName,
    sleep: deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
  }
}

/** he for a Hebrew session/meeting language, otherwise en. */
export function consentLanguage(sessionLanguage: string | null, meetingLanguage?: string): "he" | "en" {
  const language = (sessionLanguage === "he" || sessionLanguage === "en" ? sessionLanguage : meetingLanguage ?? "")
    .toLowerCase()

  return language.startsWith("he") || language === "iw" ? "he" : "en"
}

/** The localized message with `{owner}` filled (owner text stripped of URLs/markup). */
export function buildConsentMessage(rules: BotRules, language: "he" | "en", owner: string): string {
  const safeOwner =
    owner
      .replace(/[<>{}]/g, "")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "")
      .trim()
      .slice(0, 80) || "MeetSum"

  return rules.consentMessage[language].split("{owner}").join(safeOwner)
}

const DONE: readonly BotConsentStatus[] = ["sent", "unsupported", "disabled"]

export type ConsentResult = { status: BotConsentStatus | "skipped" }

export async function runBotConsent(
  input: { sessionId: string; workspaceId: string },
  deps: Partial<ConsentDeps> = {}
): Promise<ConsentResult> {
  const d = resolve(deps)
  const session = await d.store.get(input.sessionId, { workspaceId: input.workspaceId })

  if (!session) return { status: "skipped" }
  // Idempotent: once sent / unsupported / disabled there is nothing to do.
  if (DONE.includes(session.consentStatus)) return { status: "skipped" }

  const rules = await d.getRules(session.workspaceId)
  const save = async (status: BotConsentStatus) => {
    await d.store.update(session.id, { consentStatus: status }, { workspaceId: session.workspaceId })
    return { status }
  }

  if (!rules.consentEnabled) return save("disabled")
  // Only a bot that is in the meeting can announce itself.
  if (session.status !== "active") return { status: "skipped" }

  const meetingLanguage = session.meetingId
    ? await d.getMeetingLanguage(session.workspaceId, session.meetingId).catch(() => undefined)
    : undefined
  const owner = (await d.getOwnerName(session).catch(() => undefined)) ?? "MeetSum"
  const text = buildConsentMessage(rules, consentLanguage(session.language, meetingLanguage), owner)

  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await d.provider().sendChat(session.platform, session.nativeMeetingId, text)

      botLog.info(`consent ${session.id}: ${result}`)
      return save(result)
    } catch (error) {
      if (attempt >= CONSENT_RETRIES) {
        botLog.error(`consent ${session.id} failed`, error)
        return save("failed")
      }
      await d.sleep(RETRY_DELAY_MS * (attempt + 1))
    }
  }
}
