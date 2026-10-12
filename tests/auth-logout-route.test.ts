import { describe, expect, it } from "vitest"

import { GET, POST } from "@/app/api/auth/logout/route"

describe("logout route", () => {
  it("clears the session cookie and redirects POST with 303 to the locale login", async () => {
    const response = await POST(new Request("http://localhost/api/auth/logout?locale=he", { method: "POST" }))

    expect(response.status).toBe(303)
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/he/login")
    expect(response.headers.get("set-cookie")).toContain("meetsum_session=;")
  })

  it("falls back to the default locale for unknown values", async () => {
    const response = await GET(new Request("http://localhost/api/auth/logout?locale=xx"))

    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/en/login")
  })
})
