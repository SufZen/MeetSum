import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { captureLogs, restoreLogs } from "@/tests/helpers/capture-logs"

/**
 * M8 Integration step: instrumentation runs the integrations boot check.
 * Fake providers in production fail the boot (a rejected `register`, which
 * Next reports); warnings are logged; a module that fails to load is only
 * logged, never an unhandled rejection.
 */

const assertRuntimeEnvironment = vi.hoisted(() => vi.fn())
const assertIntegrationsBootConfig = vi.hoisted(() => vi.fn((): string[] => []))

vi.mock("@/lib/ops/environment", () => ({ assertRuntimeEnvironment }))
vi.mock("@/lib/search/capabilities", () => ({ warmSearchCapabilities: vi.fn(async () => undefined) }))
vi.mock("@/lib/integrations/core/http", () => ({ assertIntegrationsBootConfig }))

describe("instrumentation register()", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv("NEXT_RUNTIME", "nodejs")
    assertIntegrationsBootConfig.mockReset()
    assertIntegrationsBootConfig.mockReturnValue([])
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    restoreLogs()
  })

  it("runs the integrations boot check and logs its warnings", async () => {
    const logs = captureLogs()

    assertIntegrationsBootConfig.mockReturnValue(["MEETSUM_OAUTH_REDIRECT_BASE must be an origin"])

    const { register } = await import("@/instrumentation")

    await expect(register()).resolves.toBeUndefined()
    expect(assertIntegrationsBootConfig).toHaveBeenCalledTimes(1)
    expect(logs.messages("warn")).toContain("[integrations] MEETSUM_OAUTH_REDIRECT_BASE must be an origin")
  })

  it("fails the boot when fake providers are configured in production", async () => {
    assertIntegrationsBootConfig.mockImplementation(() => {
      throw new Error("MEETSUM_INTEGRATIONS_FAKE_BASE_URL is refused in production")
    })

    const { register } = await import("@/instrumentation")

    await expect(register()).rejects.toThrow(/production/)
  })

  it("only logs when the integrations module cannot be imported", async () => {
    const logs = captureLogs()

    vi.doMock("@/lib/integrations/core/http", () => {
      throw new Error("module failed to load")
    })

    const { register } = await import("@/instrumentation")

    await expect(register()).resolves.toBeUndefined()
    expect(logs.messages("warn")).toContainEqual(expect.stringContaining("boot check unavailable"))
    vi.doMock("@/lib/integrations/core/http", () => ({ assertIntegrationsBootConfig }))
  })
})
