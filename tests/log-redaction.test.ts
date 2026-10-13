/**
 * M10 B1 (docs/parity/m10.md, "Observability" → Redaction): seeded canaries
 * (a token, a password, an email, a Hebrew transcript sentence) never appear
 * in captured log output, through either layer (pino redact paths and the
 * deep scrub), nor through message strings or logged errors.
 */
import { afterEach, describe, expect, it } from "vitest"

import { getLogger, logger, scrub } from "@/lib/log"
import { REDACT_PATHS } from "@/lib/log/redact"
import { captureLogs, restoreLogs } from "@/tests/helpers/capture-logs"

const TOKEN = "ya29.CanaryAccessTokenValue1234567890abcdef"
const PASSWORD = "CanaryPassw0rd!"
const EMAIL = "dana.canary@example.com"
const HEBREW = "סיכום הישיבה הקנרית: הוחלט להגדיל את התקציב"
const CODE = "4/0AcanaryOauthCode"

afterEach(() => restoreLogs())

function expectNoCanary(text: string) {
  expect(text).not.toContain(TOKEN)
  expect(text).not.toContain(PASSWORD)
  expect(text).not.toContain(EMAIL)
  expect(text).not.toContain("dana.canary")
  expect(text).not.toContain(HEBREW)
  expect(text).not.toContain(CODE)
}

describe("log redaction", () => {
  it("lists the spec's redact paths (layer 1)", () => {
    for (const path of ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]', "*.token", "*.password", "*.code", "*.codeVerifier", "*.apiKey"]) {
      expect(REDACT_PATHS).toContain(path)
    }
  })

  it("redacts secrets, masks emails and omits content at any depth", () => {
    const logs = captureLogs()

    logger.info(
      {
        req: { headers: { authorization: `Bearer ${TOKEN}`, cookie: `meetsum_session=${TOKEN}` } },
        user: { email: EMAIL, password: PASSWORD },
        deep: { a: { b: { accessToken: TOKEN } } },
        oauth: { code: CODE, codeVerifier: TOKEN },
        segment: { text: HEBREW, transcript: HEBREW },
        summary: HEBREW,
        question: HEBREW,
        comment: { body: HEBREW },
      },
      "canary object"
    )

    expectNoCanary(logs.text())
    expect(logs[0].user).toMatchObject({ email: "d***@example.com", password: "[redacted]" })
    expect(logs[0].summary).toBe("[omitted]")
  })

  it("scrubs message strings and interpolation arguments", () => {
    const logs = captureLogs()

    logger.warn(`sync failed for ${EMAIL} token=${TOKEN} password=${PASSWORD} https://x.test/cb?code=${CODE}`)
    logger.info("calling %s", `https://api.example.com/v1?access_token=${TOKEN}`)

    expectNoCanary(logs.text())
    expect(logs[0].msg).toContain("d***@example.com")
  })

  it("redacts error messages and stacks (bot, integration and ASR redactors)", () => {
    const logs = captureLogs()
    const error = new Error(`upstream 401 for ${EMAIL}: {"access_token":"${TOKEN}","password":"${PASSWORD}"} code=${CODE}`)

    logger.error(error)
    getLogger({ component: "integrations" }).error({ err: error, detail: { refreshToken: TOKEN } }, "provider call failed")

    expectNoCanary(logs.text())
    expect(logs[0].err?.message).toBeDefined()
    expect(logs[0].err?.stack).toContain("at ")
    expect(logs[1].component).toBe("integrations")
  })

  it("keeps a token in a URL path out of logs (HubSpot token-in-path)", () => {
    const logs = captureLogs()

    logger.error(new Error(`GET https://api.hubapi.com/oauth/v1/refresh-tokens/${TOKEN} failed`))
    expect(logs.text()).not.toContain(TOKEN)
  })

  it("redacts secrets bound on child loggers", () => {
    const logs = captureLogs()

    getLogger({ component: "bot", apiKey: TOKEN }).info("bound")
    expectNoCanary(logs.text())
  })

  it("scrub keeps numbers, booleans, ids and token counters", () => {
    expect(scrub({ meetingId: "mtg_1", ok: true, attempts: 3, inputTokens: 1200, url: "https://a.test/p?q=1" })).toEqual({
      meetingId: "mtg_1",
      ok: true,
      attempts: 3,
      inputTokens: 1200,
      url: "https://a.test/p?[redacted]",
    })
  })

  it("scrub never throws on cycles-free deep values and truncates past depth 4", () => {
    expect(scrub({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: "[truncated]" } } } })
  })
})
