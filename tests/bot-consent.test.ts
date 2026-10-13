import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { buildConsentMessage, consentLanguage, type ConsentDeps, runBotConsent } from "@/lib/bot/consent"
import { createMemoryBotSessionStore } from "@/lib/bot/store-memory"
import type { BotSessionCreateInput } from "@/lib/bot/store"
import { type BotRules, DEFAULT_BOT_RULES } from "@/lib/bot/types"
import { VexaError } from "@/lib/bot/vexa/types"

import { fakeProvider } from "./fixtures/vexa/api/fakes"

const rules: BotRules = { ...DEFAULT_BOT_RULES, consentMessage: { ...DEFAULT_BOT_RULES.consentMessage } }

function session(overrides: Partial<BotSessionCreateInput> = {}): BotSessionCreateInput {
  return {
    workspaceId: "ws_a",
    meetingId: "meet_1",
    origin: "manual",
    platform: "zoom",
    nativeMeetingId: "81234567890",
    botName: "MeetSum Notetaker",
    status: "active",
    requestedByUserId: "user_dana",
    ...overrides,
  }
}

function setup(options: { rules?: BotRules; meetingLanguage?: string; provider?: ReturnType<typeof fakeProvider> } = {}) {
  const store = createMemoryBotSessionStore()
  const provider = options.provider ?? fakeProvider()
  const deps: Partial<ConsentDeps> = {
    store,
    provider: () => provider,
    getRules: async () => options.rules ?? rules,
    getMeetingLanguage: async () => options.meetingLanguage ?? "he",
    getOwnerName: async () => "דנה לוי",
    sleep: vi.fn(async () => undefined),
  }

  return { store, provider, deps }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("runBotConsent", () => {
  it("sends the Hebrew message for a Hebrew meeting and records `sent`", async () => {
    const { store, provider, deps } = setup()
    const created = await store.create(session())

    expect(await runBotConsent({ sessionId: created.id, workspaceId: "ws_a" }, deps)).toEqual({ status: "sent" })
    expect(provider.sendChat).toHaveBeenCalledWith(
      "zoom",
      "81234567890",
      "שלום, כאן MeetSum Notetaker. הפגישה מוקלטת ומתומללת עבור דנה לוי. מי שאינו מסכים להקלטה יכול לבקש מהמארח להוציא אותי."
    )
    expect((await store.get(created.id, { workspaceId: "ws_a" }))?.consentStatus).toBe("sent")

    // Idempotent.
    expect(await runBotConsent({ sessionId: created.id, workspaceId: "ws_a" }, deps)).toEqual({ status: "skipped" })
    expect(provider.sendChat).toHaveBeenCalledTimes(1)
  })

  it("uses English for an English session language", async () => {
    const { store, provider, deps } = setup()
    const created = await store.create(session({ language: "en" }))

    await runBotConsent({ sessionId: created.id, workspaceId: "ws_a" }, deps)
    expect(provider.sendChat.mock.calls[0][2]).toMatch(/^Hi, this is MeetSum Notetaker\. .* for דנה לוי\./)
  })

  it("records `unsupported` when chat is not available", async () => {
    const provider = fakeProvider({ sendChat: vi.fn(async () => "unsupported") })
    const { store, deps } = setup({ provider })
    const created = await store.create(session())

    expect(await runBotConsent({ sessionId: created.id, workspaceId: "ws_a" }, deps)).toEqual({ status: "unsupported" })
    expect((await store.get(created.id, { workspaceId: "ws_a" }))?.consentStatus).toBe("unsupported")
  })

  it("records `disabled` without sending when consent is off", async () => {
    const { store, provider, deps } = setup({ rules: { ...rules, consentEnabled: false } })
    const created = await store.create(session())

    expect(await runBotConsent({ sessionId: created.id, workspaceId: "ws_a" }, deps)).toEqual({ status: "disabled" })
    expect(provider.sendChat).not.toHaveBeenCalled()
  })

  it("retries twice, then records `failed`", async () => {
    const provider = fakeProvider({
      sendChat: vi.fn(async () => {
        throw new VexaError("unavailable", "Vexa POST /bots/zoom/81234567890/chat → 502")
      }),
    })
    const { store, deps } = setup({ provider })
    const created = await store.create(session())

    expect(await runBotConsent({ sessionId: created.id, workspaceId: "ws_a" }, deps)).toEqual({ status: "failed" })
    expect(provider.sendChat).toHaveBeenCalledTimes(3)
  })

  it("skips sessions that are not active or in another workspace", async () => {
    const { store, provider, deps } = setup()
    const joining = await store.create(session({ status: "joining" }))

    expect(await runBotConsent({ sessionId: joining.id, workspaceId: "ws_a" }, deps)).toEqual({ status: "skipped" })
    expect(await runBotConsent({ sessionId: joining.id, workspaceId: "ws_b" }, deps)).toEqual({ status: "skipped" })
    expect(provider.sendChat).not.toHaveBeenCalled()
  })
})

describe("helpers", () => {
  it("consentLanguage", () => {
    expect(consentLanguage(null, "he")).toBe("he")
    expect(consentLanguage(null, "mixed")).toBe("en")
    expect(consentLanguage("en", "he")).toBe("en")
    expect(consentLanguage("he", "en")).toBe("he")
  })

  it("buildConsentMessage sanitizes the owner", () => {
    expect(buildConsentMessage(rules, "en", "<b>Acme</b> https://evil.example")).toContain("for bAcme/b.")
    expect(buildConsentMessage(rules, "en", "  ")).toContain("for MeetSum.")
  })
})
