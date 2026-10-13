/**
 * Microsoft 365 provider (docs/parity/m8.md, Package B): a personal
 * connection whose only job is the Outlook calendar sync feeding M7 bot
 * rules. No `deliver` (Microsoft is never a rule target).
 *
 * Runtime wiring: the OAuth helpers and the sync job need A's
 * `providerFetch` and connection/token store, which live in Package A. They
 * are injected with `configureMicrosoftProvider` (the Integration step wires
 * it next to the registry); until then every network call fails closed with
 * a `config` ProviderError.
 */
import { cancelCalendarBotSession, syncCalendarBotSession } from "@/lib/bot/calendar-sync"
import { getBotConfig, isBotEnabled } from "@/lib/bot/config"
import {
  type IntegrationConnectionDTO,
  type IntegrationProvider,
  ProviderError,
  type ProviderFetch,
} from "@/lib/integrations/core/types"
import type { Queryable } from "@/lib/integrations/microsoft/calendar-dedupe"
import { type OutlookSyncCursor, type OutlookSyncStats, runOutlookCalendarSync } from "@/lib/integrations/microsoft/calendar-sync"
import { microsoftFakeHandlers } from "@/lib/integrations/microsoft/fake"
import { GRAPH_BASE, graphGet } from "@/lib/integrations/microsoft/graph"
import {
  MICROSOFT_SCOPES,
  exchangeMicrosoftCode,
  microsoftAuthorizeUrl,
  microsoftEnv,
  refreshMicrosoftToken,
} from "@/lib/integrations/microsoft/oauth"

/** A's connection store and token service, as the sync job needs them. */
export type MicrosoftConnectionAccess = {
  get(workspaceId: string, connectionId: string): Promise<IntegrationConnectionDTO | undefined>
  /** Row-locked refresh inside A's token service. */
  getAccessToken(workspaceId: string, connectionId: string): Promise<string>
  /** Shallow-merges non-secret keys into `config`. */
  mergeConfig(workspaceId: string, connectionId: string, patch: Record<string, unknown>): Promise<void>
}

export type MicrosoftRuntime = {
  fetch: ProviderFetch
  env: NodeJS.ProcessEnv
  connections?: MicrosoftConnectionAccess
  /** Defaults to the shared pg pool when MEETSUM_STORAGE=postgres. */
  db?: () => Queryable | undefined
  now: () => Date
}

const unwiredFetch: ProviderFetch = async () => {
  throw new ProviderError("config", "provider http not wired")
}

let runtime: MicrosoftRuntime = { fetch: unwiredFetch, env: process.env, now: () => new Date() }

export function configureMicrosoftProvider(patch: Partial<MicrosoftRuntime>): void {
  runtime = { ...runtime, ...patch }
}

export function resetMicrosoftProviderForTests(): void {
  runtime = { fetch: unwiredFetch, env: process.env, now: () => new Date() }
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number, max: number): number {
  const value = Number.parseInt(env[key] ?? "", 10)

  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback
}

async function defaultDb(): Promise<Queryable | undefined> {
  if (runtime.db) return runtime.db()
  if (runtime.env.MEETSUM_STORAGE !== "postgres") return undefined

  const { getDatabasePool } = await import("@/lib/db/client")

  return getDatabasePool() as unknown as Queryable
}

/** The connection user's email, only while they are still a member of the workspace. */
async function memberEmail(db: Queryable, workspaceId: string, userId: string): Promise<string | undefined> {
  const result = await db.query(
    `select lower(u.email) as email
       from users u
       join memberships mb on mb.user_id = u.id and mb.workspace_id = $2
      where u.id = $1
      limit 1`,
    [userId, workspaceId]
  )

  return (result.rows[0] as { email?: string } | undefined)?.email
}

export type CalendarSyncJobResult = { skipped: string } | OutlookSyncStats

/** `provider.jobs.calendarSync.run`: one connection, its own calendar, its own workspace. */
export async function runCalendarSyncJob(params: { workspaceId: string; connectionId: string }): Promise<CalendarSyncJobResult> {
  const access = runtime.connections

  if (!access) throw new ProviderError("config", "microsoft connection access not wired")

  const connection = await access.get(params.workspaceId, params.connectionId)

  if (!connection || connection.provider !== "microsoft") return { skipped: "connection_not_found" }
  if (connection.status !== "active") return { skipped: "connection_inactive" }
  if (!connection.userId) return { skipped: "connection_not_personal" }
  if (connection.config.calendarSyncEnabled !== true) return { skipped: "sync_disabled" }

  const db = await defaultDb()

  if (!db) return { skipped: "no_database" }

  const userEmail = await memberEmail(db, params.workspaceId, connection.userId)

  if (!userEmail) return { skipped: "user_not_member" }

  const { getAppSettings } = await import("@/lib/settings/app-settings")
  const settings = await getAppSettings(params.workspaceId)
  const env = runtime.env

  return runOutlookCalendarSync({
    db,
    fetch: runtime.fetch,
    getAccessToken: () => access.getAccessToken(params.workspaceId, params.connectionId),
    workspaceId: params.workspaceId,
    connectionId: params.connectionId,
    userId: connection.userId,
    userEmail,
    cursor: (connection.config.calendarSync ?? {}) as OutlookSyncCursor,
    saveConfig: (patch) => access.mergeConfig(params.workspaceId, params.connectionId, patch),
    settings: {
      defaultMeetingVisibility: settings.defaultMeetingVisibility,
      language: settings.meetingLanguageMode === "auto" ? "mixed" : settings.meetingLanguageMode,
    },
    botEnabled: isBotEnabled(env),
    botAccountEmail: getBotConfig(env).accountEmail,
    syncBot: (input) => syncCalendarBotSession(input),
    cancelBot: (input) => cancelCalendarBotSession(input),
    lookaheadDays: envInt(env, "MEETSUM_MS_CALENDAR_LOOKAHEAD_DAYS", 14, 60),
    now: runtime.now,
  })
}

export const microsoftProvider: IntegrationProvider = {
  id: "microsoft",
  scope: "user",
  configured: (env = runtime.env) => microsoftEnv(env) !== undefined,
  oauth: {
    pkce: true,
    scopes: [...MICROSOFT_SCOPES],
    authorizeUrl: (params) => microsoftAuthorizeUrl(params, runtime.env),
    exchangeCode: (code, params) => exchangeMicrosoftCode(code, params, runtime),
    refresh: (refreshToken) => refreshMicrosoftToken(refreshToken, runtime),
    // Microsoft has no token revocation endpoint for this flow; disconnect wipes locally.
  },
  async test(ctx) {
    await graphGet(ctx.fetch, await ctx.getAccessToken(), `${GRAPH_BASE}/me?$select=id`)
  },
  jobs: {
    calendarSync: {
      get everyMinutes() {
        return envInt(runtime.env, "MEETSUM_MS_CALENDAR_SYNC_MINUTES", 10, 24 * 60)
      },
      run: runCalendarSyncJob,
    },
  },
  fake: microsoftFakeHandlers,
}
