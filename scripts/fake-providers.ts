/**
 * `npm run integrations:fake` — the dev/e2e fake provider server on
 * 127.0.0.1:4010 (docs/parity/m8.md, Acceptance 14). Serves every
 * registered provider's `fake` routes. Never runs in production. Point the
 * app and worker at it with MEETSUM_INTEGRATIONS_FAKE_BASE_URL.
 */
import { listProviders } from "@/lib/integrations/core/registry"
import { createFakeProviderServer, mergeFakeHandlers } from "@/lib/integrations/testing/fake-server"

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("[fake-providers] refused: NODE_ENV=production")
    process.exit(1)
  }

  const port = Number(process.env.MEETSUM_FAKE_PROVIDERS_PORT ?? 4010)
  const handlers = mergeFakeHandlers(...listProviders().map((provider) => provider.fake))
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
