/**
 * M10 Step 0 (docs/parity/m10.md, "Frozen after Step 0"): the exported API of
 * lib/log/index.ts. Package B owns the internals (redaction, formatters,
 * service detection) and its own log-redaction / log-context tests; this file
 * only pins the signatures and the base fields every line carries.
 */
import { describe, expect, expectTypeOf, it } from "vitest"

import * as log from "@/lib/log"
import { getLogger, logger, scrub, withLogContext, type LogContext, type Logger } from "@/lib/log"
import packageJson from "@/package.json"

describe("lib/log API (frozen at M10 Step 0)", () => {
  it("exports exactly logger, getLogger, withLogContext and scrub", () => {
    expect(Object.keys(log).sort()).toEqual(["getLogger", "logger", "scrub", "withLogContext"])
  })

  it("binds service and the package.json version on the root logger", () => {
    const bindings = logger.bindings()

    expect(["app", "worker", "migrate"]).toContain(bindings.service)
    expect(bindings.version).toBe(packageJson.version)
    expectTypeOf(logger).toEqualTypeOf<Logger>()
  })

  it("getLogger returns a child that keeps the base fields and adds its bindings", () => {
    const child = getLogger({ component: "contract" })

    expect(child.bindings()).toMatchObject({ component: "contract", version: packageJson.version })
    expectTypeOf(getLogger).parameter(0).toEqualTypeOf<Record<string, unknown>>()
  })

  it("withLogContext returns the callback's result, sync or async", async () => {
    expect(withLogContext({ reqId: "req-12345678" }, () => 42)).toBe(42)
    await expect(withLogContext({ jobId: "job-1", queue: "meetsum" }, async () => "done")).resolves.toBe("done")
    expectTypeOf(withLogContext).parameter(0).toEqualTypeOf<LogContext>()
  })

  it("scrub is pure, keeps the value's type and redacts secret-ish keys", () => {
    const input = { meetingId: "mtg_1", nested: { accessToken: "t0ken", ok: true } }
    const output = scrub(input)

    expectTypeOf(output).toEqualTypeOf(input)
    expect(output).toEqual({ meetingId: "mtg_1", nested: { accessToken: "[redacted]", ok: true } })
    expect(input.nested.accessToken).toBe("t0ken")
  })
})
