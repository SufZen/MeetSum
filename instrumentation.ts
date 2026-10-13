export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertRuntimeEnvironment } = await import("@/lib/ops/environment")

    assertRuntimeEnvironment()

    // M8: refuse fake integration providers in production (throws, so boot
    // fails) and log configuration warnings. A failure to load the module is
    // only logged: it must never become an unhandled rejection.
    let integrations: typeof import("@/lib/integrations/core/http") | undefined

    try {
      integrations = await import("@/lib/integrations/core/http")
    } catch {
      console.warn("[integrations] boot check unavailable: the integrations module failed to load")
    }

    if (integrations) {
      for (const warning of integrations.assertIntegrationsBootConfig()) {
        console.warn(`[integrations] ${warning}`)
      }
    }

    // M6: detect pgvector / Hebrew trigram support once at boot and log the
    // search mode. Never blocks startup; failures degrade to lexical search.
    void import("@/lib/search/capabilities")
      .then((m) => m.warmSearchCapabilities())
      .catch(() => undefined)
  }
}
