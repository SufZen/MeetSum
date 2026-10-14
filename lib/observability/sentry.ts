/**
 * Optional Sentry (or GlitchTip, same DSN variable) for the app server and
 * the worker (docs/parity/m10.md, "Sentry").
 *
 * This module is imported only when `SENTRY_DSN` is set: `instrumentation.ts`
 * and `worker/index.ts` import it dynamically behind that check, and it loads
 * `@sentry/node` itself with a dynamic import. No client SDK.
 *
 * `sendDefaultPii: false`, `tracesSampleRate` from SENTRY_TRACES_SAMPLE_RATE
 * (default 0), `environment` from SENTRY_ENVIRONMENT, `release` =
 * `meetsum@<package version>[+<MEETSUM_GIT_SHA>]`. Every event and breadcrumb
 * goes through lib/observability/scrub.ts.
 */
import type { NodeOptions } from "@sentry/node"

import { getLogger, type LogService } from "@/lib/log"
import { scrubSentryBreadcrumb, scrubSentryEvent } from "@/lib/observability/scrub"
import packageJson from "@/package.json"

type SentryModule = typeof import("@sentry/node")

export type SentryHandle = {
  captureException(error: unknown, context?: { tags?: Record<string, string> }): void
  flush(timeoutMs?: number): Promise<boolean>
}

let handle: SentryHandle | undefined
let initializing: Promise<SentryHandle | undefined> | undefined

export function sentryDsn(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dsn = env.SENTRY_DSN?.trim()

  return dsn ? dsn : undefined
}

function sampleRate(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.SENTRY_TRACES_SAMPLE_RATE)

  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0
}

export function sentryRelease(env: NodeJS.ProcessEnv = process.env): string {
  const sha = env.MEETSUM_GIT_SHA?.trim()

  return `meetsum@${packageJson.version}${sha && /^[0-9a-f]{7,40}$/i.test(sha) ? `+${sha.slice(0, 12)}` : ""}`
}

/** The `Sentry.init` options (exported for tests). */
export function sentryOptions(service: LogService, env: NodeJS.ProcessEnv = process.env): NodeOptions {
  return {
    dsn: sentryDsn(env),
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || "development",
    release: sentryRelease(env),
    sendDefaultPii: false,
    tracesSampleRate: sampleRate(env),
    initialScope: { tags: { service } },
    beforeSend: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
  }
}

/**
 * Initializes Sentry once per process; returns undefined (and never loads
 * `@sentry/node`) when SENTRY_DSN is unset. Failures are logged, never thrown.
 */
export async function initSentry(
  service: LogService,
  options: { env?: NodeJS.ProcessEnv; load?: () => Promise<SentryModule> } = {}
): Promise<SentryHandle | undefined> {
  const env = options.env ?? process.env

  if (!sentryDsn(env)) return undefined
  if (handle) return handle

  initializing ??= (async () => {
    try {
      const Sentry = await (options.load ?? (() => import("@sentry/node")))()

      Sentry.init(sentryOptions(service, env))
      handle = {
        captureException: (error, context) => {
          Sentry.captureException(error, context?.tags ? { tags: context.tags } : undefined)
        },
        flush: (timeoutMs = 2000) => Sentry.flush(timeoutMs),
      }
      getLogger({ component: "observability" }).info({ release: sentryRelease(env) }, "Sentry error reporting enabled")
      return handle
    } catch (error) {
      getLogger({ component: "observability" }).error({ err: error }, "Sentry initialization failed; error reporting disabled")
      return undefined
    } finally {
      initializing = undefined
    }
  })()

  return initializing
}

/** Reports an error when Sentry is initialized; a no-op otherwise. */
export function captureError(error: unknown, tags?: Record<string, string>) {
  try {
    handle?.captureException(error, tags ? { tags } : undefined)
  } catch {
    // Reporting must never throw into the caller.
  }
}

/** Flushes pending events (shutdown); resolves true when nothing is pending. */
export async function flushSentry(timeoutMs = 2000): Promise<boolean> {
  try {
    return handle ? await handle.flush(timeoutMs) : true
  } catch {
    return false
  }
}

/** Tests: forget the initialized client. */
export function resetSentryForTesting() {
  handle = undefined
  initializing = undefined
}
