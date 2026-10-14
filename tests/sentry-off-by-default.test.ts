/**
 * M10 B2: Sentry is off without SENTRY_DSN. The observability module (and
 * through it @sentry/node) is never imported: instrumentation and the worker
 * import it dynamically behind the DSN check, and nothing imports
 * @sentry/node statically (type-only imports are erased).
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sentryModuleLoaded = vi.hoisted(() => vi.fn())
const initSentry = vi.hoisted(() => vi.fn(async () => undefined))
const captureError = vi.hoisted(() => vi.fn())

vi.mock("@/lib/observability/sentry", () => {
  sentryModuleLoaded()
  return { initSentry, captureError }
})
vi.mock("@/lib/ops/environment", () => ({ assertRuntimeEnvironment: vi.fn() }))
vi.mock("@/lib/search/capabilities", () => ({ warmSearchCapabilities: vi.fn(async () => undefined) }))
vi.mock("@/lib/integrations/core/http", () => ({ assertIntegrationsBootConfig: vi.fn(() => []) }))

const root = path.resolve(__dirname, "..")

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const full = path.join(dir, name)

    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full)
  }
  return out
}

describe("Sentry off by default", () => {
  beforeEach(() => {
    vi.resetModules()
    sentryModuleLoaded.mockClear()
    initSentry.mockClear()
    captureError.mockClear()
    vi.stubEnv("NEXT_RUNTIME", "nodejs")
  })

  afterEach(() => vi.unstubAllEnvs())

  it("never imports the Sentry module when SENTRY_DSN is unset (register and onRequestError)", async () => {
    vi.stubEnv("SENTRY_DSN", "")

    const instrumentation = await import("@/instrumentation")

    await instrumentation.register()
    await instrumentation.onRequestError(new Error("boom"), { path: "/api/x", method: "GET", headers: {} }, { routePath: "/api/x" })

    expect(sentryModuleLoaded).not.toHaveBeenCalled()
    expect(initSentry).not.toHaveBeenCalled()
  })

  it("initializes Sentry for the app and forwards request errors when SENTRY_DSN is set", async () => {
    vi.stubEnv("SENTRY_DSN", "https://public@glitchtip.example.com/1")

    const instrumentation = await import("@/instrumentation")

    await instrumentation.register()
    await instrumentation.onRequestError(new Error("boom"), { path: "/api/x", method: "GET", headers: {} }, { routePath: "/api/meetings/[id]" })

    expect(initSentry).toHaveBeenCalledWith("app")
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), { route: "/api/meetings/[id]" })
  })

  it("the worker loads Sentry only behind the SENTRY_DSN check", () => {
    const worker = readFileSync(path.join(root, "worker/index.ts"), "utf8")

    expect(worker).not.toMatch(/^import[^\n]*observability\/sentry/m)
    expect(worker).toMatch(/SENTRY_DSN[\s\S]{0,200}import\("@\/lib\/observability\/sentry"\)/)
  })

  it("nothing imports @sentry/node at runtime except the dynamic import in lib/observability/sentry.ts", () => {
    const offenders = ["lib", "app", "worker", "instrumentation.ts", "proxy.ts", "mcp", "components"]
      .map((entry) => path.join(root, entry))
      .flatMap((entry) => (statSync(entry).isDirectory() ? sourceFiles(entry) : [entry]))
      .filter((file) => {
        const source = readFileSync(file, "utf8")
        const staticImport = /^import\s+(?!type\b)[^\n]*from\s+["']@sentry\//m.test(source)
        const requireCall = /require\(["']@sentry\//.test(source)
        const dynamic = /import\(["']@sentry\//.test(source) && !file.replace(/\\/g, "/").endsWith("lib/observability/sentry.ts")

        return staticImport || requireCall || dynamic
      })

    expect(offenders).toEqual([])
  })
})
