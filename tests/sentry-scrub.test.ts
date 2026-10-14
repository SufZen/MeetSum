/**
 * M10 B2 + security check 1: `beforeSend` / `beforeBreadcrumb` drop cookies,
 * authorization, request bodies and query strings, user email and IP, and
 * scrub messages, exception values, extra and contexts (canary transcript).
 */
import type { ErrorEvent } from "@sentry/node"
import { describe, expect, it, vi } from "vitest"

import { scrubSentryBreadcrumb, scrubSentryEvent } from "@/lib/observability/scrub"
import { initSentry, resetSentryForTesting, sentryOptions, sentryRelease } from "@/lib/observability/sentry"

const TOKEN = "ya29.SentryCanaryToken1234567890abcdef"
const EMAIL = "noa.canary@example.com"
const HEBREW = "הקנרית: הוחלט לאשר את התקציב השנתי"

function canaryEvent(): ErrorEvent {
  return {
    type: undefined,
    message: `failed for ${EMAIL} with token=${TOKEN}`,
    request: {
      url: `https://meetsum.example.com/api/share/abc?password=hunter2&token=${TOKEN}`,
      method: "POST",
      cookies: { meetsum_session: TOKEN },
      headers: { authorization: `Bearer ${TOKEN}`, cookie: `meetsum_session=${TOKEN}` },
      data: { question: HEBREW },
      query_string: `token=${TOKEN}`,
    },
    user: { id: "user_1", email: EMAIL, ip_address: "203.0.113.5" },
    exception: {
      values: [
        {
          type: "Error",
          value: `upstream rejected {"access_token":"${TOKEN}"} for ${EMAIL}`,
          stacktrace: { frames: [{ filename: "app.js", function: "run", vars: { transcript: HEBREW, token: TOKEN } }] },
        },
      ],
    },
    extra: { transcript: HEBREW, nested: { apiKey: TOKEN }, owner: EMAIL },
    contexts: { meeting: { summary: HEBREW, id: "mtg_1" } },
    breadcrumbs: [{ category: "http", data: { url: `https://api.example.com/v1?key=${TOKEN}`, method: "GET" }, message: `GET for ${EMAIL}` }],
  }
}

describe("Sentry scrubbing", () => {
  it("removes every canary from an event", () => {
    const scrubbed = scrubSentryEvent(canaryEvent())
    const text = JSON.stringify(scrubbed)

    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(EMAIL)
    expect(text).not.toContain(HEBREW)
    expect(text).not.toContain("hunter2")
    expect(text).not.toContain("203.0.113.5")
    expect(scrubbed.request).toEqual({ url: "https://meetsum.example.com/api/share/abc", method: "POST" })
    expect(scrubbed.user).toEqual({ id: "user_1" })
    expect(scrubbed.contexts?.meeting).toEqual({ summary: "[omitted]", id: "mtg_1" })
  })

  it("scrubs breadcrumbs: URL without query, message and data scrubbed", () => {
    const breadcrumb = scrubSentryBreadcrumb({
      category: "fetch",
      message: `POST for ${EMAIL}`,
      data: { url: `https://hooks.example.com/x?sig=${TOKEN}`, authorization: `Bearer ${TOKEN}`, status_code: 500 },
    })

    expect(breadcrumb.data).toEqual({ url: "https://hooks.example.com/x", authorization: "[redacted]", status_code: 500 })
    expect(JSON.stringify(breadcrumb)).not.toContain(EMAIL)
  })

  it("configures no default PII, a 0 sample rate by default and a versioned release", () => {
    const env = { SENTRY_DSN: "https://k@sentry.example.com/1", MEETSUM_GIT_SHA: "0123456789abcdef", NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv
    const options = sentryOptions("worker", env)

    expect(options.sendDefaultPii).toBe(false)
    expect(options.tracesSampleRate).toBe(0)
    expect(options.environment).toBe("production")
    expect(options.release).toBe(sentryRelease(env))
    expect(options.release).toMatch(/^meetsum@\d+\.\d+\.\d+\+0123456789ab$/)
    expect(options.beforeSend?.(canaryEvent(), {})).toBeTruthy()
  })

  it("initSentry loads the SDK only with a DSN, once, and wires beforeSend", async () => {
    resetSentryForTesting()
    const init = vi.fn()
    const load = vi.fn(async () => ({ init, captureException: vi.fn(), flush: vi.fn(async () => true) }) as never)

    expect(await initSentry("app", { env: {} as NodeJS.ProcessEnv, load })).toBeUndefined()
    expect(load).not.toHaveBeenCalled()

    const env = { SENTRY_DSN: "https://k@sentry.example.com/1" } as unknown as NodeJS.ProcessEnv

    await initSentry("app", { env, load })
    await initSentry("app", { env, load })

    expect(load).toHaveBeenCalledTimes(1)
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ dsn: "https://k@sentry.example.com/1", sendDefaultPii: false }))
    resetSentryForTesting()
  })
})
