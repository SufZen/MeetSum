// Server-only modules (pino, Sentry) are imported dynamically inside the
// nodejs branch so this file stays safe for any edge compilation.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getLogger } = await import("@/lib/log")
    const log = getLogger({ component: "boot" })

    // M10 B2: optional Sentry/GlitchTip. Without SENTRY_DSN the module (and
    // @sentry/node) is never imported.
    if (process.env.SENTRY_DSN?.trim()) {
      const { initSentry } = await import("@/lib/observability/sentry")

      await initSentry("app")
    }

    const { assertRuntimeEnvironment } = await import("@/lib/ops/environment")

    assertRuntimeEnvironment()

    // M8: refuse fake integration providers in production (throws, so boot
    // fails) and log configuration warnings. A failure to load the module is
    // only logged: it must never become an unhandled rejection.
    let integrations: typeof import("@/lib/integrations/core/http") | undefined

    try {
      integrations = await import("@/lib/integrations/core/http")
    } catch {
      log.warn("[integrations] boot check unavailable: the integrations module failed to load")
    }

    if (integrations) {
      for (const warning of integrations.assertIntegrationsBootConfig()) {
        log.warn(`[integrations] ${warning}`)
      }
    }

    // M6: detect pgvector / Hebrew trigram support once at boot and log the
    // search mode. Never blocks startup; failures degrade to lexical search.
    void import("@/lib/search/capabilities")
      .then((m) => m.warmSearchCapabilities())
      .catch(() => undefined)
  }
}

type RequestErrorContext = {
  routerKind?: string
  routePath?: string
  routeType?: string
}

/**
 * Next.js request-error hook (M10 B2): always logged through pino (scrubbed;
 * the route path is the template, never the URL), and forwarded to Sentry
 * when SENTRY_DSN is set.
 */
export async function onRequestError(
  error: unknown,
  request: { path?: string; method?: string; headers?: Record<string, string | string[] | undefined> },
  context: RequestErrorContext
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return

  try {
    const { getLogger } = await import("@/lib/log")
    const { isValidRequestId } = await import("@/lib/log/request-id")
    const requestId = request.headers?.["x-request-id"]

    getLogger({ component: "next" }).error(
      {
        err: error,
        reqId: typeof requestId === "string" && isValidRequestId(requestId) ? requestId : undefined,
        method: request.method,
        route: context.routePath,
        routeType: context.routeType,
        routerKind: context.routerKind,
      },
      "request failed"
    )

    if (process.env.SENTRY_DSN?.trim()) {
      const { captureError } = await import("@/lib/observability/sentry")

      captureError(error, {
        ...(context.routePath ? { route: context.routePath } : {}),
        ...(context.routeType ? { routeType: context.routeType } : {}),
      })
    }
  } catch {
    // The error hook must never throw.
  }
}
