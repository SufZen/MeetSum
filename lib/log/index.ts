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
 *
 * Redaction has two layers: pino `redact.paths` (REDACT_PATHS) and the deep
 * scrub in `formatters.log` (lib/log/redact.ts). Message strings and the
 * message of a logged Error are scrubbed in the `logMethod` hook, because
 * they never reach the formatter.
 */
import { AsyncLocalStorage } from "node:async_hooks"

import pino from "pino"

import { redactBotText } from "@/lib/bot/redact"
import { maskEmails, REDACT_PATHS, redactErrorMessage, scrubString, scrubValue } from "@/lib/log/redact"
import { logDestination } from "@/lib/log/sink"
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

/** Message strings: URL queries, key=value secrets, bearer values, blobs, emails. */
function scrubMessage(message: string): string {
  try {
    return maskEmails(redactBotText(scrubString(message)))
  } catch {
    return "[redacted]"
  }
}

function scrubArg(arg: unknown): unknown {
  return typeof arg === "string" ? scrubMessage(arg) : scrubValue(arg)
}

/**
 * Returns a copy of `value` that is safe to log or send to Sentry: secret-ish
 * keys are redacted and content keys omitted at any depth (up to 4 levels),
 * emails are masked, URL queries stripped and error text redacted. Pure;
 * never mutates.
 */
export function scrub<T>(value: T): T {
  return scrubValue(value)
}

/** The root logger. Every line carries `service` and `version`. */
export const logger: Logger = pino(
  {
    level: resolveLevel(),
    base: { service: resolveService(), version: packageJson.version },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: "msg",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    formatters: {
      level: (label) => ({ level: label }),
      bindings: (bindings) => scrubValue(bindings),
      log: (object) => scrubValue(object),
    },
    hooks: {
      logMethod(args, method) {
        const [first, ...rest] = args as unknown[]

        if (first instanceof Error) {
          const message =
            typeof rest[0] === "string" ? scrubMessage(rest.shift() as string) : redactErrorMessage(first.message ?? "")

          return method.apply(this, [{ err: first }, message, ...rest.map(scrubArg)] as unknown as Parameters<typeof method>)
        }

        const scrubbed = args.map((arg, index) => (index === 0 && typeof arg !== "string" ? arg : scrubArg(arg)))

        return method.apply(this, scrubbed as unknown as Parameters<typeof method>)
      },
    },
    mixin: () => ({ ...contextStore.getStore() }),
  },
  logDestination
)

/** A child logger with static bindings, e.g. `getLogger({ component: "bot" })`. */
export function getLogger(bindings: LogBindings): Logger {
  return logger.child(scrubValue(bindings))
}

/**
 * Runs `fn` with `bindings` merged into the current log context (nested calls
 * add to the outer context). Lines logged by any logger inside `fn`, including
 * across awaits, carry these fields.
 */
export function withLogContext<T>(bindings: LogContext, fn: () => T): T {
  return contextStore.run({ ...contextStore.getStore(), ...bindings }, fn)
}
