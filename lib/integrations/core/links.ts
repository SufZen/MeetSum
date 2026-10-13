/**
 * App links for recaps (docs/parity/m8.md, Step 0 item 7) and the
 * workspace/connection-scoped LinkStore handed to providers. Owned by
 * Package A. Uses the M4 deep-link format without a `t` offset.
 */
import type { IntegrationStore } from "@/lib/integrations/core/store"
import type { LinkStore, ProviderId } from "@/lib/integrations/core/types"
import { buildSegmentLink } from "@/lib/player/deep-link"

function appOrigin(env: NodeJS.ProcessEnv): string {
  return (env.NEXT_PUBLIC_APP_URL?.trim() || env.MEETINGS_APP_URL?.trim() || "").replace(/\/+$/, "")
}

/** `${APP}/{locale}?meeting=<id>`; relative when no app URL is configured. */
export function meetingAppUrl(meetingId: string, locale: string, env: NodeJS.ProcessEnv = process.env): string {
  const link = buildSegmentLink({ origin: appOrigin(env), locale, meetingId, ms: 0 })
  const [path, query = ""] = link.split("?")
  const params = new URLSearchParams(query)

  params.delete("t")

  return `${path}?${params.toString()}`
}

/** App locale for a meeting language (he → he, else en). */
export function recapLocale(language: string | undefined): "he" | "en" {
  return (language ?? "").toLowerCase().startsWith("he") ? "he" : "en"
}

/**
 * URL of an existing, active, unexpired meeting share of a `link`-visible
 * meeting in the workspace (never creates one). Postgres only; undefined in
 * memory mode or on any error.
 */
export async function findActiveShareUrl(
  workspaceId: string,
  meetingId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  if (env.MEETSUM_STORAGE !== "postgres") return undefined

  try {
    const { getDatabasePool } = await import("@/lib/db/client")
    const result = await getDatabasePool().query(
      `select s.token from meeting_shares s join meetings m on m.id = s.meeting_id
        where s.meeting_id = $1 and m.workspace_id = $2 and m.visibility = 'link'
          and s.scope = 'meeting' and not s.revoked and (s.expires_at is null or s.expires_at > now())
        order by s.created_at desc limit 1`,
      [meetingId, workspaceId]
    )
    const token = (result.rows[0] as { token?: string } | undefined)?.token

    return token ? `${appOrigin(env)}/share/${encodeURIComponent(token)}` : undefined
  } catch {
    return undefined
  }
}

/** LinkStore bound to one workspace, connection and meeting. */
export function createLinkStore(
  store: IntegrationStore,
  scope: { workspaceId: string; connectionId: string; meetingId: string; provider: ProviderId }
): LinkStore {
  const base = { workspaceId: scope.workspaceId, connectionId: scope.connectionId, meetingId: scope.meetingId }

  return {
    get: (key) => store.getLink(base, key),
    list: (objectKind, destinationKey) => store.listLinks(base, objectKind, destinationKey),
    upsert: (key) => store.upsertLink({ ...base, provider: scope.provider }, key),
    remove: (key) => store.removeLink(base, key),
  }
}

/** For providers without a connection (email): no external objects. */
export const NO_LINKS: LinkStore = {
  get: async () => undefined,
  list: async () => [],
  upsert: async () => {
    throw new Error("links are not available for this provider")
  },
  remove: async () => undefined,
}
