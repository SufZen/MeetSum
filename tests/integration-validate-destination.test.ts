import { describe, expect, it } from "vitest"

import { listProviders } from "@/lib/integrations/core/registry"
import type { ProviderCtx, RuleDestination } from "@/lib/integrations/core/types"

/**
 * M8 Integration step: every provider implements `validateDestination`, so
 * rules and manual sends with an explicit destination are checked with the
 * provider (a provider without it would make the routes refuse them).
 * Providers that are never a destination (Microsoft, Google Docs) reject
 * every destination; email accepts only its own shape.
 */

const ctx = { workspaceId: "ws_a" } as unknown as ProviderCtx
const SLACK: RuleDestination = { provider: "slack", channelId: "C1", channelName: "x" }
const EMAIL: RuleDestination = { provider: "email", audience: "members", mode: "opt_in", locale: "meeting" }

describe("validateDestination coverage", () => {
  it("is implemented by every registered provider", () => {
    expect(listProviders().filter((provider) => !provider.validateDestination).map((provider) => provider.id)).toEqual([])
  })

  it("rejects any destination for Microsoft and Google Docs, and non-email shapes for email", async () => {
    const byId = new Map(listProviders().map((provider) => [provider.id, provider]))

    await expect(byId.get("microsoft")?.validateDestination?.(SLACK, ctx)).rejects.toMatchObject({ kind: "invalid" })
    await expect(byId.get("google_drive")?.validateDestination?.(SLACK, ctx)).rejects.toMatchObject({ kind: "invalid" })
    await expect(byId.get("email")?.validateDestination?.(SLACK, ctx)).rejects.toMatchObject({ kind: "invalid" })
    await expect(byId.get("email")?.validateDestination?.(EMAIL, ctx)).resolves.toBeUndefined()
  })

  it("rejects a Notion destination without a database and a malformed HubSpot deal id before any call", async () => {
    const byId = new Map(listProviders().map((provider) => [provider.id, provider]))

    await expect(
      byId.get("notion")?.validateDestination?.({ provider: "notion", databaseId: "", databaseTitle: "" }, ctx)
    ).rejects.toMatchObject({ kind: "invalid" })
    await expect(
      byId.get("hubspot")?.validateDestination?.(
        { provider: "hubspot", dealId: "../1", logAs: "meeting", createTasks: false, createMissingContacts: false, matchInternal: false },
        ctx
      )
    ).rejects.toMatchObject({ kind: "invalid" })
  })
})
