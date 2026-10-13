import { readFileSync } from "node:fs"

import { afterEach, describe, expect, it, vi } from "vitest"

import { integrationsApi } from "@/components/integrations/api"

/**
 * M8 Integration step: the webhooks section creates v2 subscriptions
 * (`payloadVersion`), reads the event list from `GET /api/webhooks/catalog`
 * (no hard-coded fallback), and uses its own "Add webhook" / "Rotate
 * signing secret" strings.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("webhooks section", () => {
  it("sends payloadVersion when creating a subscription (v2 by default)", async () => {
    const fetch = vi.fn(async () => Response.json({ subscription: { id: "wh_1" }, secret: "s" }, { status: 201 }))

    vi.stubGlobal("fetch", fetch)
    await integrationsApi.createWebhook("https://hooks.example/x", ["clip.created"])

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]

    expect(url).toBe("/api/webhooks/subscriptions")
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://hooks.example/x", events: ["clip.created"], payloadVersion: 2 })
  })

  it("reads the catalog endpoint, has no fallback event list, and no borrowed labels", () => {
    const source = readFileSync("components/integrations/webhooks-section.tsx", "utf8")

    expect(source).toContain("integrationsApi.webhookCatalog()")
    expect(source).not.toMatch(/FALLBACK_EVENTS/)
    expect(source).toContain("t.integrationsWebhookAdd")
    expect(source).toContain("t.integrationsWebhookRotateSecret")
    expect(source).not.toMatch(/botInternalDomainsAdd|intelRegenerate/)
  })
})
