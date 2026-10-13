/**
 * M10 B1 + security check 2 (docs/parity/m10.md): the proxy accepts a valid
 * incoming `x-request-id`, replaces anything else (newlines, control
 * characters, wrong length) with a fresh UUID, forwards it to the route and
 * echoes it on the response; the route wrappers put it in the log context.
 */
import { NextRequest, NextResponse } from "next/server"
import { afterEach, describe, expect, it } from "vitest"

import { withPublicRoute } from "@/lib/auth/authz"
import { getLogger } from "@/lib/log"
import { isValidRequestId, resolveRequestId, routeTemplate } from "@/lib/log/request-id"
import { config, proxy } from "@/proxy"
import { captureLogs, restoreLogs } from "@/tests/helpers/capture-logs"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

afterEach(() => restoreLogs())

describe("request ids", () => {
  it("keeps a valid incoming id", () => {
    expect(resolveRequestId("abc.DEF_123-xyz")).toBe("abc.DEF_123-xyz")
  })

  it.each([
    ["too short", "abc"],
    ["too long", "a".repeat(65)],
    ["newline injection", "abcdefgh\n{\"level\":\"error\"}"],
    ["control character", "abcdefgh\u0000"],
    ["spaces", "abcd efgh"],
    ["missing", null],
  ])("replaces an invalid id (%s) with a UUID", (_label, value) => {
    const id = resolveRequestId(value)

    expect(id).toMatch(UUID)
    expect(isValidRequestId(id)).toBe(true)
  })

  it("forwards and echoes the id on pass-through and redirects", () => {
    const pass = proxy(new NextRequest("http://localhost/api/meetings", { headers: { "x-request-id": "client-req-0001" } }))

    expect(pass.headers.get("x-request-id")).toBe("client-req-0001")
    expect(pass.headers.get("x-middleware-request-x-request-id")).toBe("client-req-0001")

    const redirect = proxy(new NextRequest("http://localhost/tasks", { headers: { "x-request-id": "bad id;drop" } }))

    expect(redirect.status).toBe(307)
    expect(redirect.headers.get("x-request-id")).toMatch(UUID)
  })

  it("runs the proxy on API routes but not on static files", () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`)

    expect(matcher.test("/api/meetings")).toBe(true)
    expect(matcher.test("/he/tasks")).toBe(true)
    expect(matcher.test("/_next/static/chunk.js")).toBe(false)
    expect(matcher.test("/sw.js")).toBe(false)
  })

  it("builds route templates without ids, tokens or queries", () => {
    expect(routeTemplate("http://x/api/share/AbC123tokenXYZ/verify?password=1")).toBe("/api/share/[id]/verify")
    expect(routeTemplate("http://x/api/v1/meetings/8f14e45f-ceea-467a-9e3f-2a6c9b1d0e11")).toBe("/api/v1/meetings/[id]")
  })

  it("puts reqId, route, method and principal into the route's log context", async () => {
    const logs = captureLogs()
    const handler = withPublicRoute("test route", async () => {
      getLogger({ component: "test" }).info("handled")
      return NextResponse.json({ ok: true })
    })

    await handler(new Request("http://localhost/api/share/tok3n123/verify", { headers: { "x-request-id": "req-from-proxy-1" } }), {
      params: Promise.resolve({}),
    })

    expect(logs[0]).toMatchObject({ reqId: "req-from-proxy-1", route: "/api/share/[id]/verify", method: "GET", principal: "public" })
  })
})
