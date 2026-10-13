/**
 * `npm run integrations:fake` — the dev/e2e fake provider server on
 * 127.0.0.1:4010 (docs/parity/m8.md, Acceptance 14). Serves every
 * registered provider's `fake` routes (Slack, Microsoft, Notion, HubSpot,
 * Google Docs), each bound to its own hosts, plus the inspection routes
 * (`GET`/`DELETE /__fake/requests?provider=`) and a webhook receiver
 * (`POST /__fake/webhook`). Never runs in production.
 *
 * Point the app and worker at it (development only):
 *   MEETSUM_INTEGRATIONS_FAKE_BASE_URL=http://127.0.0.1:4010
 *   MEETSUM_WEBHOOK_ALLOWED_HOSTS=127.0.0.1   (the webhook receiver is loopback)
 *   MEETSUM_MS_CALENDAR_SYNC_MINUTES=1        (Outlook sync every minute)
 */
import { listProviders } from "@/lib/integrations/core/registry"
import { allProviderFakeHandlers, createFakeProviderServer } from "@/lib/integrations/testing/fake-server"

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("[fake-providers] refused: NODE_ENV=production")
    process.exit(1)
  }

  const port = Number(process.env.MEETSUM_FAKE_PROVIDERS_PORT ?? 4010)
  const handlers = allProviderFakeHandlers(listProviders())
  const server = await createFakeProviderServer(handlers, { port })

  console.log(`[fake-providers] listening on ${server.url} (${Object.keys(handlers).length} routes)`)

  const stop = async () => {
    await server.close()
    process.exit(0)
  }

  process.on("SIGINT", () => void stop())
  process.on("SIGTERM", () => void stop())
}

void main()
