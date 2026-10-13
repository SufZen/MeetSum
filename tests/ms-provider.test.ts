import { afterEach, describe, expect, it } from "vitest"

import type { IntegrationConnectionDTO } from "@/lib/integrations/core/types"
import { configureMicrosoftProvider, microsoftProvider, resetMicrosoftProviderForTests } from "@/lib/integrations/microsoft/provider"

import { createFakeFetch, json } from "./helpers/provider-fake-fetch"

const connection = (overrides: Partial<IntegrationConnectionDTO> = {}): IntegrationConnectionDTO => ({
  id: "intc_ms_1",
  provider: "microsoft",
  status: "active",
  accountLabel: "yossi@acme.co.il",
  scopes: [],
  userId: "usr_yossi",
  createdAt: "",
  config: { calendarSyncEnabled: true },
  ...overrides,
})

function access(found: IntegrationConnectionDTO | undefined) {
  const tokenCalls: string[] = []

  return {
    tokenCalls,
    connections: {
      get: async (workspaceId: string, connectionId: string) =>
        found && workspaceId === "ws_1" && connectionId === found.id ? found : undefined,
      getAccessToken: async (workspaceId: string) => {
        tokenCalls.push(workspaceId)
        return "token"
      },
      mergeConfig: async () => undefined,
    },
  }
}

afterEach(() => resetMicrosoftProviderForTests())

describe("microsoft provider", () => {
  it("fails closed when A's runtime is not wired", async () => {
    await expect(microsoftProvider.jobs?.calendarSync?.run({ workspaceId: "ws_1", connectionId: "c" })).rejects.toMatchObject({ kind: "config" })
    await expect(
      microsoftProvider.oauth?.exchangeCode("c", { redirectUri: "r", codeVerifier: "v" }) ?? Promise.resolve()
    ).rejects.toMatchObject({ kind: "config" })
  })

  it("syncs only an active personal connection of this workspace with sync enabled, never fetching a token otherwise", async () => {
    const cases: Array<[IntegrationConnectionDTO | undefined, string, string]> = [
      [undefined, "ws_1", "connection_not_found"],
      [connection(), "ws_2", "connection_not_found"],
      [connection({ provider: "slack" }), "ws_1", "connection_not_found"],
      [connection({ status: "needs_reauth" }), "ws_1", "connection_inactive"],
      [connection({ userId: undefined }), "ws_1", "connection_not_personal"],
      [connection({ config: {} }), "ws_1", "sync_disabled"],
      [connection(), "ws_1", "no_database"],
    ]

    for (const [found, workspaceId, skipped] of cases) {
      const fake = access(found)

      configureMicrosoftProvider({ connections: fake.connections, env: {} as NodeJS.ProcessEnv })
      await expect(microsoftProvider.jobs?.calendarSync?.run({ workspaceId, connectionId: "intc_ms_1" })).resolves.toEqual({ skipped })
      expect(fake.tokenCalls).toEqual([])
    }
  })

  it("skips a connection whose user is no longer a member of the workspace", async () => {
    const fake = access(connection())

    configureMicrosoftProvider({
      connections: fake.connections,
      env: {} as NodeJS.ProcessEnv,
      db: () => ({ query: async () => ({ rows: [] }) }),
    })
    await expect(microsoftProvider.jobs?.calendarSync?.run({ workspaceId: "ws_1", connectionId: "intc_ms_1" })).resolves.toEqual({
      skipped: "user_not_member",
    })
  })

  it("runs every MEETSUM_MS_CALENDAR_SYNC_MINUTES (default 10) and tests with Graph /me", async () => {
    configureMicrosoftProvider({ env: {} as NodeJS.ProcessEnv })
    expect(microsoftProvider.jobs?.calendarSync?.everyMinutes).toBe(10)
    configureMicrosoftProvider({ env: { MEETSUM_MS_CALENDAR_SYNC_MINUTES: "30" } as unknown as NodeJS.ProcessEnv })
    expect(microsoftProvider.jobs?.calendarSync?.everyMinutes).toBe(30)

    const { fetch, calls } = createFakeFetch([{ match: "GET https://graph.microsoft.com/v1.0/me", respond: json({ id: "x" }) }])

    await microsoftProvider.test?.({ workspaceId: "ws_1", connection: connection(), getAccessToken: async () => "tok", fetch })
    expect(calls[0]?.url).toBe("https://graph.microsoft.com/v1.0/me?$select=id")
  })
})
