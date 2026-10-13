/**
 * Google Drive provider: the personal connection behind the Google Docs
 * export (docs/parity/m8.md, C2). Owner: Package C.
 *
 * It is not a rule provider (no `deliver`): the export runs from
 * `POST /api/meetings/[id]/export/google-docs` for the requester's own Drive.
 */
import { ProviderError, type IntegrationProvider, type ProviderFetch } from "@/lib/integrations/core/types"
import { createFakeGoogleDocsHandlers } from "@/lib/integrations/google-docs/fake"
import {
  exchangeGoogleDocsCode,
  GOOGLE_DRIVE_FILE_SCOPE,
  googleDocsAuthorizeUrl,
  googleDocsClientConfig,
  googleDocsTokenInfo,
  refreshGoogleDocsToken,
  revokeGoogleDocsToken,
} from "@/lib/integrations/google-docs/oauth"
import { getManualExportRuntime } from "@/lib/integrations/notion/manual-export-runtime"

function oauthFetch(): ProviderFetch {
  const runtime = getManualExportRuntime()

  if (!runtime) throw new ProviderError("config", "integration_runtime_unavailable")

  return runtime.providerFetch
}

export const googleDocsProvider: IntegrationProvider = {
  id: "google_drive",
  scope: "user",
  configured: (env = process.env) => Boolean(googleDocsClientConfig(env)),
  oauth: {
    pkce: true,
    scopes: [GOOGLE_DRIVE_FILE_SCOPE],
    authorizeUrl: (params) => googleDocsAuthorizeUrl(params),
    exchangeCode: async (code, params) => exchangeGoogleDocsCode(code, params, { fetch: oauthFetch() }),
    refresh: async (refreshToken) => refreshGoogleDocsToken(refreshToken, { fetch: oauthFetch() }),
    revoke: async (tokens) => revokeGoogleDocsToken(tokens, { fetch: oauthFetch() }),
  },
  test: async (ctx) => googleDocsTokenInfo(await ctx.getAccessToken(), { fetch: ctx.fetch }),
  fake: createFakeGoogleDocsHandlers(),
}
