import { describe, expect, expectTypeOf, it } from "vitest"

import { meetingAppUrl } from "@/lib/integrations/core/links"
import { INTEGRATIONS_QUEUE, INTEGRATION_JOB_NAMES } from "@/lib/integrations/core/queue"
import {
  PERSONAL_PROVIDER_IDS,
  PROVIDER_IDS,
  ProviderError,
  WORKSPACE_PROVIDER_IDS,
  type IntegrationConnectionDTO,
  type IntegrationDeliveryDTO,
  type IntegrationRuleDTO,
} from "@/lib/integrations/core/types"
import { CATALOG_VERSION, WEBHOOK_EVENTS_V1, WEBHOOK_EVENTS_V2, webhookEventsFor } from "@/lib/platform/event-catalog"
import { WEBHOOK_EVENT_NAMES } from "@/lib/webhooks/management"

/** M8 Step 0: frozen contracts (docs/parity/m8.md, "Shared contracts"). */

type TokenishKeys<T> = Extract<keyof T, `${string}${"token" | "Token" | "_enc" | "Enc" | "secret" | "Secret"}${string}`>

describe("integration contracts", () => {
  it("never carries tokens in the DTOs (type-level)", () => {
    expectTypeOf<TokenishKeys<IntegrationConnectionDTO>>().toEqualTypeOf<never>()
    expectTypeOf<TokenishKeys<IntegrationRuleDTO>>().toEqualTypeOf<never>()
    expectTypeOf<TokenishKeys<IntegrationDeliveryDTO>>().toEqualTypeOf<never>()
  })

  it("splits providers into workspace and personal connections", () => {
    expect([...WORKSPACE_PROVIDER_IDS, ...PERSONAL_PROVIDER_IDS].sort()).toEqual([...PROVIDER_IDS].sort())
  })

  it("keeps ProviderError fields", () => {
    const error = new ProviderError("rate_limited", "slow down", { retryAfterMs: 3000, providerCode: "ratelimited" })

    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: "ProviderError", kind: "rate_limited", retryAfterMs: 3000, providerCode: "ratelimited" })
  })

  it("freezes the webhook catalog: v1 is today's list, v2 adds four events and keeps summary.created", () => {
    expect(CATALOG_VERSION).toBe(2)
    expect([...WEBHOOK_EVENTS_V1]).toEqual([...WEBHOOK_EVENT_NAMES])
    expect(WEBHOOK_EVENTS_V2.slice(WEBHOOK_EVENTS_V1.length)).toEqual([
      "action_item.updated",
      "clip.created",
      "bot.status_changed",
      "integration.delivery.failed",
    ])
    expect(WEBHOOK_EVENTS_V2).toContain("summary.created")
    expect(webhookEventsFor(1)).toBe(WEBHOOK_EVENTS_V1)
  })

  it("names the integrations queue and its jobs", () => {
    expect(INTEGRATIONS_QUEUE).toBe("meetsum-integrations")
    expect(INTEGRATION_JOB_NAMES).toEqual([
      "integration.dispatch",
      "integration.deliver",
      "integration.job",
      "integration.tick",
      "integration.sweep",
    ])
  })

  it("builds the app link without a time offset", () => {
    expect(meetingAppUrl("m 1", "he", { NEXT_PUBLIC_APP_URL: "https://meetsum.example/" } as unknown as NodeJS.ProcessEnv)).toBe(
      "https://meetsum.example/he?meeting=m+1"
    )
    expect(meetingAppUrl("m_1", "en", {} as NodeJS.ProcessEnv)).toBe("/en?meeting=m_1")
  })
})
