/**
 * `npm run integrations:fake` — the dev/e2e fake provider server on
 * 127.0.0.1:4010 (docs/parity/m8.md, Acceptance 14). Serves every
 * registered provider's `fake` routes (Slack, Microsoft, Notion, HubSpot,
 * Google Docs), each bound to its own hosts, plus the inspection routes
 * (`GET`/`DELETE /__fake/requests?provider=`) and a webhook receiver
 * (`POST /__fake/webhook`). Never runs in production.
 *
 * M10: it also serves the fake ASR under `/asr` (lib/testing/fake-asr.ts),
 * an OpenAI-compatible Whisper stand-in that answers from
 * tests/fixtures/e2e/asr by the uploaded audio.
 *
 * Point the app and worker at it (development only):
 *   MEETSUM_INTEGRATIONS_FAKE_BASE_URL=http://127.0.0.1:4010
 *   MEETSUM_WEBHOOK_ALLOWED_HOSTS=127.0.0.1   (the webhook receiver is loopback)
 *   MEETSUM_MS_CALENDAR_SYNC_MINUTES=1        (Outlook sync every minute)
 *   LOCAL_TRANSCRIPTION_URL=http://127.0.0.1:4010/asr  (fake ASR)
 *   MEETSUM_ASR_CHAIN=local-whisper-chunked
 */
import { listProviders } from "@/lib/integrations/core/registry"
import {
  allProviderFakeHandlers,
  createFakeProviderServer,
  type FakeProviderServer,
} from "@/lib/integrations/testing/fake-server"
import { createFakeAsr, FAKE_ASR_PREFIX } from "@/lib/testing/fake-asr"

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("[fake-providers] refused: NODE_ENV=production")
    process.exit(1)
  }

  const port = Number(process.env.MEETSUM_FAKE_PROVIDERS_PORT ?? 4010)
  const handlers = allProviderFakeHandlers(listProviders())
  const sink: { server?: FakeProviderServer } = {}
  const asr = createFakeAsr({
    log: (entry) => {
      sink.server?.record(entry)
      console.log(
        `[fake-asr] ${entry.method} ${entry.path}${entry.body ? ` -> ${entry.body.fixtureId ?? "no fixture"}${entry.body.matchedBy ? ` (${entry.body.matchedBy})` : ""}` : ""}`
      )
    },
  })

  const server = await createFakeProviderServer(handlers, { port, rawRoutes: [{ prefix: FAKE_ASR_PREFIX, handle: asr }] })

  sink.server = server

  console.log(`[fake-providers] listening on ${server.url} (${Object.keys(handlers).length} routes + fake ASR at ${FAKE_ASR_PREFIX})`)

  const stop = async () => {
    await server.close()
    process.exit(0)
  }

  process.on("SIGINT", () => void stop())
  process.on("SIGTERM", () => void stop())
}

void main()
