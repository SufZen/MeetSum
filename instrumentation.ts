export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertRuntimeEnvironment } = await import("@/lib/ops/environment")

    assertRuntimeEnvironment()

    // M6: detect pgvector / Hebrew trigram support once at boot and log the
    // search mode. Never blocks startup; failures degrade to lexical search.
    void import("@/lib/search/capabilities")
      .then((m) => m.warmSearchCapabilities())
      .catch(() => undefined)
  }
}
