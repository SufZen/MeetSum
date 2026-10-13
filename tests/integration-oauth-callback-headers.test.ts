import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth/authz", () => ({
  withSession:
    (handler: (request: Request, session: unknown, route: unknown) => Promise<Response>) =>
    (request: Request, route: unknown) =>
      handler(request, { user: { id: "u" }, memberships: [] }, route),
}))
vi.mock("@/lib/integrations/core/oauth", () => ({
  completeOAuth: vi.fn(async () => ({ location: "/he?panel=settings&section=integrations", code: undefined })),
}))

import { GET } from "@/app/api/integrations/[provider]/oauth/callback/route"

/**
 * M8 e2e fix #9: the OAuth callback redirects at once (the state nonce is
 * single-use, so a replayed `code` fails), is never cached, and sends no
 * Referer carrying the `code` to the next page. (Next's dev request log
 * printing the callback URL is dev-only.)
 */
describe("integration OAuth callback response", () => {
  it("redirects immediately with no-store, no-referrer and a cleared state cookie", async () => {
    const response = await GET(new Request("http://localhost/api/integrations/slack/oauth/callback?code=secret-code&state=s"), {
      params: Promise.resolve({ provider: "slack" }),
    } as never)

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/he?panel=settings&section=integrations")
    expect(response.headers.get("location")).not.toContain("secret-code")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/)
  })
})
