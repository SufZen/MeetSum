import { describe, expect, it } from "vitest"

import { graphError, isSyncStateLost } from "@/lib/integrations/microsoft/graph"

/**
 * M10 R2: Graph error handling checked against
 * https://learn.microsoft.com/en-us/graph/errors and the delta-query overview
 * on 2026-10-14 (docs/runbooks/integrations.md, "Verified against vendor docs").
 */
const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("graphError", () => {
  it("treats a nested innererror syncStateNotFound as a lost delta token", async () => {
    const error = await graphError(respond(400, { error: { code: "badRequest", innererror: { code: "syncStateNotFound" } } }))

    expect(error.providerCode).toBe("syncStateNotFound")
    expect(isSyncStateLost(error)).toBe(true)
  })

  it("keeps the top-level code otherwise, and 410 still resets", async () => {
    expect((await graphError(respond(400, { error: { code: "badRequest", innererror: { code: "other" } } }))).providerCode).toBe("badRequest")
    expect(isSyncStateLost(await graphError(respond(410, {})))).toBe(true)
    expect(isSyncStateLost(await graphError(respond(404, { error: { code: "ErrorItemNotFound" } })))).toBe(false)
  })
})
