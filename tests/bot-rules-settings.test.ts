import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock("@/lib/db/client", () => ({
  getDatabasePool: () => ({ query: mocks.query }),
}))

const {
  BOT_RULES_SETTING_KEY,
  BotRulesValidationError,
  getBotRules,
  parseStoredBotRules,
  resetBotRulesMemory,
  updateBotRules,
} = await import("@/lib/settings/bot-rules")
const { DEFAULT_BOT_RULES } = await import("@/lib/bot/types")

const NOW = new Date("2026-10-13T10:00:00.000Z")

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as InstanceType<typeof BotRulesValidationError>
  }
  throw new Error("expected a rejection")
}

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: [] })
  resetBotRulesMemory()
})

afterEach(() => {
  delete process.env.MEETSUM_STORAGE
  delete process.env.MEETSUM_BOT_NAME
})

describe("bot rules (memory)", () => {
  it("defaults to auto-join off with the configured bot name", async () => {
    process.env.MEETSUM_BOT_NAME = "Acme Notetaker"

    const rules = await getBotRules("ws_a")

    expect(rules).toMatchObject({ ...DEFAULT_BOT_RULES, botName: "Acme Notetaker", autoJoin: "off" })
  })

  it("requires the consent acknowledgment before enabling auto-join", async () => {
    const error = await rejection(updateBotRules("ws_a", { autoJoin: "all" }, { userId: "u1" }))

    expect(error).toBeInstanceOf(BotRulesValidationError)
    expect(error.code).toBe("consent_ack_required")
    expect((await getBotRules("ws_a")).autoJoin).toBe("off")
  })

  it("acknowledgeConsent stamps time and actor and unlocks auto-join", async () => {
    const rules = await updateBotRules(
      "ws_a",
      { autoJoin: "external_only", acknowledgeConsent: true },
      { userId: "user_admin" },
      { now: NOW }
    )

    expect(rules).toMatchObject({
      autoJoin: "external_only",
      consentAcknowledgedAt: NOW.toISOString(),
      consentAcknowledgedByUserId: "user_admin",
    })
    // Later patches keep the acknowledgment.
    expect((await updateBotRules("ws_a", { autoJoin: "all" }, { userId: "u2" })).consentAcknowledgedByUserId).toBe(
      "user_admin"
    )
    expect((await getBotRules("ws_b")).autoJoin).toBe("off")
  })

  it("clamps numbers and normalizes lists", async () => {
    const rules = await updateBotRules(
      "ws_a",
      {
        joinLeadSeconds: 9000,
        minAttendees: 0,
        skipTitlePatterns: [" 1:1 ", "1:1", "פרטי"],
        internalDomains: ["@Acme.co.il", "acme.co.il", "labs.acme.io"],
      },
      {}
    )

    expect(rules).toMatchObject({
      joinLeadSeconds: 600,
      minAttendees: 1,
      skipTitlePatterns: ["1:1", "פרטי"],
      internalDomains: ["acme.co.il", "labs.acme.io"],
    })
    expect((await updateBotRules("ws_a", { joinLeadSeconds: -5 }, {})).joinLeadSeconds).toBe(0)
  })

  it("reports per-field errors", async () => {
    const error = await rejection(
      updateBotRules(
        "ws_a",
        {
          autoJoin: "sometimes",
          botName: "",
          consentEnabled: "yes",
          consentMessage: { he: "הקלטה https://evil.example", en: "x".repeat(501) },
          languageMode: "fr",
          joinLeadSeconds: "60",
          internalDomains: ["not a domain"],
          skipTitlePatterns: "1:1",
        },
        {}
      )
    )

    expect(error.code).toBe("invalid")
    expect(error.errors.map((item) => item.path).sort()).toEqual([
      "autoJoin",
      "botName",
      "consentEnabled",
      "consentMessage.en",
      "consentMessage.he",
      "internalDomains.0",
      "joinLeadSeconds",
      "languageMode",
      "skipTitlePatterns",
    ])
  })

  it("rejects URLs in consent messages", async () => {
    const error = await rejection(updateBotRules("ws_a", { consentMessage: { en: "see www.acme.com" } }, {}))

    expect(error.errors).toEqual([{ path: "consentMessage.en", message: "must not contain URLs" }])
    expect(
      (await updateBotRules("ws_a", { consentMessage: { he: "שלום, הפגישה מוקלטת עבור {owner}." } }, {})).consentMessage.he
    ).toBe("שלום, הפגישה מוקלטת עבור {owner}.")
  })
})

describe("bot rules (postgres)", () => {
  beforeEach(() => {
    process.env.MEETSUM_STORAGE = "postgres"
  })

  it("reads workspace_settings and tolerates invalid stored fields", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ value: { autoJoin: "all", joinLeadSeconds: 120, botName: 42, consentAcknowledgedAt: "2026-10-01T00:00:00.000Z" } }],
    })

    const rules = await getBotRules("ws_pg")

    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("workspace_settings"), ["ws_pg", BOT_RULES_SETTING_KEY])
    expect(rules).toMatchObject({ autoJoin: "all", joinLeadSeconds: 120, botName: DEFAULT_BOT_RULES.botName })
  })

  it("stored auto-join without an acknowledgment reads as off", () => {
    expect(parseStoredBotRules({ autoJoin: "all", joinLeadSeconds: 30 })).toMatchObject({
      autoJoin: "off",
      joinLeadSeconds: 30,
    })
  })

  it("upserts the validated rules", async () => {
    await updateBotRules("ws_pg", { acknowledgeConsent: true, autoJoin: "owner_only" }, { userId: "u1" }, { now: NOW })

    const [sql, params] = mocks.query.mock.calls[1]

    expect(sql).toContain("on conflict (workspace_id, key)")
    expect(params[0]).toBe("ws_pg")
    expect(JSON.parse(params[2] as string)).toMatchObject({
      autoJoin: "owner_only",
      consentAcknowledgedAt: NOW.toISOString(),
      consentAcknowledgedByUserId: "u1",
    })
  })
})
