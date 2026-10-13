/**
 * Notion provider (docs/parity/m8.md, C1). Owner: Package C.
 *
 * A workspace connection (admins connect it with OAuth). Rule deliveries
 * and the manual export both go through `deliver` → `deliverNotionPage`,
 * which creates the page or updates the tracked one in place. The token
 * only ever comes from the connection (`getAccessToken`), never from a
 * request body or a server-wide environment variable.
 */
import {
  ProviderError,
  type IntegrationProvider,
  type PickerPage,
  type ProviderCtx,
  type ProviderFetch,
  type RuleDestination,
} from "@/lib/integrations/core/types"
import { notionRequest, type NotionClientContext } from "@/lib/integrations/notion/client"
import { deliverNotionPage } from "@/lib/integrations/notion/deliver"
import { createFakeNotionHandlers } from "@/lib/integrations/notion/fake"
import { getManualExportRuntime } from "@/lib/integrations/notion/manual-export-runtime"
import {
  exchangeNotionCode,
  notionAuthorizeUrl,
  notionClientConfig,
  refreshNotionToken,
} from "@/lib/integrations/notion/oauth"
import { notionDatabaseTitle, type NotionDatabase } from "@/lib/integrations/notion/properties"

/** OAuth calls have no ProviderCtx: they use the registered `providerFetch`. */
function oauthFetch(): ProviderFetch {
  const runtime = getManualExportRuntime()

  if (!runtime) throw new ProviderError("config", "integration_runtime_unavailable")

  return runtime.providerFetch
}

function clientOf(ctx: ProviderCtx): NotionClientContext {
  return { fetch: ctx.fetch, getAccessToken: () => ctx.getAccessToken() }
}

type SearchResult = { results?: (NotionDatabase & { object?: string; id: string })[]; next_cursor?: string | null; has_more?: boolean }

/** Databases the integration can see, 50 per page (`POST /v1/search`). */
export async function pickNotionDatabases(
  ctx: ProviderCtx,
  query: { query?: string; cursor?: string }
): Promise<PickerPage> {
  const result = await notionRequest<SearchResult>(clientOf(ctx), "POST", "/v1/search", {
    ...(query.query?.trim() ? { query: query.query.trim().slice(0, 200) } : {}),
    filter: { property: "object", value: "database" },
    page_size: 50,
    ...(query.cursor ? { start_cursor: query.cursor } : {}),
  })

  return {
    items: (result.results ?? [])
      .filter((database) => !database.archived && !database.in_trash)
      .map((database) => ({ id: database.id, label: notionDatabaseTitle(database) || "Untitled" })),
    ...(result.has_more && result.next_cursor ? { nextCursor: result.next_cursor } : {}),
  }
}

async function validateNotionDestination(destination: RuleDestination, ctx: ProviderCtx): Promise<void> {
  if (destination.provider !== "notion" || !destination.databaseId) {
    throw new ProviderError("invalid", "notion_destination_required")
  }

  const database = await notionRequest<NotionDatabase>(
    clientOf(ctx),
    "GET",
    `/v1/databases/${encodeURIComponent(destination.databaseId)}`
  )

  if (database.archived || database.in_trash) throw new ProviderError("invalid", "notion_database_archived")
}

export const notionProvider: IntegrationProvider = {
  id: "notion",
  scope: "workspace",
  configured: (env = process.env) => Boolean(notionClientConfig(env)),
  oauth: {
    pkce: false,
    scopes: [],
    authorizeUrl: (params) => notionAuthorizeUrl(params),
    exchangeCode: async (code, params) => exchangeNotionCode(code, params, { fetch: oauthFetch() }),
    refresh: async (refreshToken) => refreshNotionToken(refreshToken, { fetch: oauthFetch() }),
  },
  test: async (ctx) => {
    await notionRequest(clientOf(ctx), "GET", "/v1/users/me")
  },
  pickers: { databases: pickNotionDatabases },
  validateDestination: validateNotionDestination,
  deliver: (input) => deliverNotionPage(input),
  fake: createFakeNotionHandlers(),
}
