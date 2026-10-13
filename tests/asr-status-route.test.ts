import { beforeEach, describe, expect, it, vi } from "vitest"

import { routeParams } from "./helpers/route-ctx"
import { testAuthContext, testAuthState } from "./helpers/auth-context"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const { mockAuthzModule } = await import("./helpers/auth-context")

  return mockAuthzModule(importOriginal)
})

const getAsrRouterStatus = vi.hoisted(() => vi.fn())

vi.mock("@/lib/ai/asr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/asr")>()

  return { ...actual, getAsrRouterStatus }
})

import { GET } from "@/app/api/asr/status/route"
import type { WorkspaceRole } from "@/lib/workspaces/types"

const status = {
  chain: ["runpod-ivrit", "soniox"],
  nonHebrewChain: ["soniox", "runpod-ivrit"],
  providers: [
    { provider: "runpod-ivrit", configured: true, healthy: true },
    {
      provider: "soniox",
      configured: true,
      healthy: false,
      breakerOpenUntil: "2026-10-13T01:00:00.000Z",
      lastError: "server",
    },
  ],
}

const get = () => GET(new Request("http://localhost/api/asr/status"), routeParams({}))

function as(role: WorkspaceRole) {
  testAuthState.ctx = testAuthContext({ role })
}

beforeEach(() => {
  testAuthState.ctx = undefined
  testAuthState.permissions = []
  getAsrRouterStatus.mockReset()
  getAsrRouterStatus.mockResolvedValue(status)
})

describe("GET /api/asr/status", () => {
  it("returns the router chains and provider health to an admin", async () => {
    as("admin")

    const response = await get()

    expect(response.status).toBe(200)
    expect(testAuthState.permissions).toEqual(["ops:read"])
    expect(await response.json()).toEqual(status)
  })

  it.each(["viewer", "member"] as const)("answers 403 for a %s", async (role) => {
    as(role)

    const response = await get()

    expect(response.status).toBe(403)
    expect(getAsrRouterStatus).not.toHaveBeenCalled()
  })

  it("answers 401 without a session", async () => {
    expect((await get()).status).toBe(401)
  })
})
