/**
 * The server logger (docs/parity/m10.md, "Observability").
 *
 * M10 Step 0 freezes the exported API of this module: `logger`, `getLogger`,
 * `withLogContext`, `scrub` and the `Logger`, `LogBindings`, `LogContext`,
 * `LogService` types. Package B owns everything behind them (redaction paths,
 * the deep-scrub formatter, the bot/integration/ASR redactors, service
 * detection) and may change the internals, never the signatures.
 *
 * Output is one JSON object per line on stdout, with no transports (pino
 * transports run in worker threads, which Next bundling breaks; `pino` is in
 * `serverExternalPackages`). `pino-pretty` is a developer pipe, not a
 * dependency. Server-only: never import this module from client components.
 */
import { AsyncLocalStorage } from "node:async_hooks"

import pino from "pino"

import packageJson from "@/package.json"

export type Logger = pino.Logger

/** Which process wrote the line. */
export type LogService = "app" | "worker" | "migrate"

/** Static fields bound to a child logger, e.g. `{ component: "bot" }`. */
export type LogBindings = Record<string, unknown>

/**
 * Per-request / per-job fields carried through AsyncLocalStorage and merged
 * into every line logged inside `withLogContext`. Never put transcript,
 * summary, question or comment text, emails or secrets here.
 */
export type LogContext = {
  reqId?: string
  route?: string
  method?: string
  workspaceId?: string
  principal?: "session" | "api_key" | "public"
  jobId?: string
  queue?: string
  jobName?: string
  [key: string]: string | number | boolean | undefined
}

const contextStore = new AsyncLocalStorage<LogContext>()

/** `info` in production, `debug` otherwise; `LOG_LEVEL` overrides. */
function resolveLevel(): string {
  const configured = process.env.LOG_LEVEL?.trim().toLowerCase()

  if (configured) return configured

  return process.env.NODE_ENV === "production" ? "info" : "debug"
}

function resolveService(): LogService {
  if (process.env.NEXT_RUNTIME) return "app"

  const entry = (process.argv[1] ?? "").replace(/\\/g, "/")

  if (/(^|\/)worker\/index\.[cm]?[jt]s$/.test(entry)) return "worker"
  if (/(^|\/)scripts\/migrate\.[cm]?[jt]s$/.test(entry)) return "migrate"

  return "app"
}

/** Keys whose values are replaced by "[redacted]" at any depth (B extends this). */
const SECRET_KEY = /token|secret|password|passcode|authori[sz]ation|cookie|api[-_]?key|verifier|signature/i
const SCRUB_MAX_DEPTH = 4
const REDACTED = "[redacted]"

function scrubAt(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object") return value
  if (depth >= SCRUB_MAX_DEPTH) return "[truncated]"
  if (Array.isArray(value)) return value.map((item) => scrubAt(item, depth + 1))
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }

  const out: Record<string, unknown> = {}

  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : scrubAt(inner, depth + 1)
  }

  return out
}

/**
 * Returns a copy of `value` that is safe to log or send to Sentry: secret-ish
 * keys are redacted at any depth (up to 4 levels). Pure; never mutates.
 */
export function scrub<T>(value: T): T {
  return scrubAt(value, 0) as T
}

/** The root logger. Every line carries `service` and `version`. */
export const logger: Logger = pino({
  level: resolveLevel(),
  base: { service: resolveService(), version: packageJson.version },
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: "msg",
  formatters: {
    level: (label) => ({ level: label }),
    log: (object) => scrub(object),
  },
  mixin: () => ({ ...contextStore.getStore() }),
})

/** A child logger with static bindings, e.g. `getLogger({ component: "bot" })`. */
export function getLogger(bindings: LogBindings): Logger {
  return logger.child(bindings)
}

/**
 * Runs `fn` with `bindings` merged into the current log context (nested calls
 * add to the outer context). Lines logged by any logger inside `fn`, including
 * across awaits, carry these fields.
 */
export function withLogContext<T>(bindings: LogContext, fn: () => T): T {
  return contextStore.run({ ...contextStore.getStore(), ...bindings }, fn)
}
