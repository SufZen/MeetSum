import { describe, expect, it } from "vitest"

import { GET, POST } from "@/app/api/auth/logout/route"

const route = { params: Promise.resolve({}) }

describe("logout route", () => {
  it("clears the session cookie and redirects POST with 303 to the locale login", async () => {
    const response = await POST(new Request("http://localhost/api/auth/logout?locale=he", { method: "POST" }), route)

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/he/login")
    expect(response.headers.get("set-cookie")).toContain("meetsum_session=;")
    expect(response.headers.get("set-cookie")).toContain("meetsum_workspace=;")
  })

  it("falls back to the default locale for unknown values", async () => {
    const response = await GET(new Request("http://localhost/api/auth/logout?locale=xx"), route)

    expect(response.headers.get("location")).toBe("/en/login")
  })
})
