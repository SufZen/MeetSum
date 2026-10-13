import { assertVexaConfig, getBotConfig } from "@/lib/bot/config"
import { getBotProvider } from "@/lib/bot/vexa/client"
import { VEXA_WEBHOOK_EVENTS, VexaError, type VexaWebhookEvent } from "@/lib/bot/vexa/types"

/**
 * Configures the Vexa webhook for MeetSum (M7 Package C1). Run on the server
 * after deploy/vexa/bootstrap.sh and after minting the API token:
 *
 *   npm run vexa:configure            # health, PUT /user/webhook, GET /user/webhook
 *   npm run vexa:configure -- --check # health and the current webhook only
 *
 * The URL is VEXA_WEBHOOK_URL, else NEXT_PUBLIC_APP_URL +
 * /api/integrations/vexa/webhook. If the gateway rejects an internal URL,
 * set VEXA_WEBHOOK_URL to the public https URL (docs/runbooks/vexa.md).
 * Secrets are never printed; URLs are printed without their query.
 */

const WEBHOOK_PATH = "/api/integrations/vexa/webhook"

function mask(value: string | undefined): string {
  if (!value) return "(unset)"

  return value.length <= 8 ? "********" : `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`
}

function displayUrl(value: string | undefined): string {
  if (!value) return "(none)"
  try {
    const url = new URL(value)

    return `${url.origin}${url.pathname}`
  } catch {
    return "(invalid URL)"
  }
}

function resolveWebhookUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.VEXA_WEBHOOK_URL?.trim()

  if (explicit) return explicit

  const appUrl = env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "")

  if (!appUrl) throw new Error("Set VEXA_WEBHOOK_URL or NEXT_PUBLIC_APP_URL")

  return `${appUrl}${WEBHOOK_PATH}`
}

async function main() {
  const checkOnly = process.argv.includes("--check")
  const config = getBotConfig()
  const { baseUrl: apiUrl, apiKey } = assertVexaConfig(config)
  const secret = config.vexa.webhookSecret

  console.log(`Vexa gateway: ${displayUrl(apiUrl)} (key ${mask(apiKey)})`)

  const provider = getBotProvider()
  const health = await provider.health()

  console.log(`health: ${health.ok ? "ok" : "NOT OK"}${health.version ? ` (version ${health.version})` : ""}`)
  if (!health.ok) process.exitCode = 1
  if (health.version && health.version.replace(/^v/, "") !== config.vexa.version) {
    console.warn(`warning: gateway reports ${health.version}, VEXA_VERSION is ${config.vexa.version}`)
  }

  if (!checkOnly) {
    if (!secret || secret.length < 32) {
      throw new Error("VEXA_WEBHOOK_SECRET must be set and at least 32 characters")
    }

    const url = resolveWebhookUrl(process.env)
    const events = Object.fromEntries(
      VEXA_WEBHOOK_EVENTS.map((event) => [event, true])
    ) as Record<VexaWebhookEvent, boolean>

    await provider.configureWebhook({ url, secret, events })
    console.log(`webhook set: ${displayUrl(url)} (secret ${mask(secret)})`)
  }

  const current = await provider.getWebhook()
  const enabled = Object.entries(current.events ?? {})
    .filter(([, on]) => on)
    .map(([event]) => event)

  console.log(`webhook now: ${displayUrl(current.url)}`)
  console.log(`events: ${enabled.length ? enabled.join(", ") : "(none reported)"}`)
  console.log(
    `secret configured: ${current.secretConfigured === undefined ? "unknown (not reported)" : current.secretConfigured ? "yes" : "NO"}`
  )
}

main().catch((error: unknown) => {
  const message =
    error instanceof VexaError
      ? `Vexa ${error.kind}${error.status ? ` (${error.status})` : ""}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error)

  console.error(`vexa:configure failed: ${message}`)
  if (error instanceof VexaError && error.kind === "invalid") {
    console.error(
      `If the gateway rejected an internal URL, set VEXA_WEBHOOK_URL=https://<public host>${WEBHOOK_PATH} and re-run.`
    )
  }
  process.exit(1)
})
