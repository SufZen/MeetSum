import { type BotProvider, VexaError, type VexaClientOptions } from "@/lib/bot/vexa/types"

export { VexaError } from "@/lib/bot/vexa/types"
export type { BotProvider, VexaClientOptions } from "@/lib/bot/vexa/types"

/**
 * Vexa HTTP client (M7 Package A1). Step 0 stub: always throws
 * VexaError("config"). The real client is the only module under lib/bot that
 * may call fetch.
 */
export function createVexaClient(options: VexaClientOptions): BotProvider {
  void options

  throw new VexaError("config", "Vexa client not implemented (M7)")
}

/** Process-wide provider built from getBotConfig(). Step 0 stub: throws. */
export function getBotProvider(): BotProvider {
  throw new VexaError("config", "Vexa client not implemented (M7)")
}
