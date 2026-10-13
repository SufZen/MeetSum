import { describe, expect, it } from "vitest"

import { createFakeNotionHandlers } from "@/lib/integrations/notion/fake"

/** M8 e2e fix #6: the fake Notion answers 404 for an unknown database id, as real Notion does. */
describe("fake Notion databases", () => {
  const request = (id: string) => ({ method: "GET", path: `/v1/databases/${id}`, query: {}, headers: {}, body: undefined })

  it("returns the fake database for its id and 404 object_not_found for any other id", () => {
    const handlers = createFakeNotionHandlers()
    const known = handlers["GET /v1/databases/:id"](request("fake-notion-db-0001")) as { status?: number; body: { id: string } }
    const forged = handlers["GET /v1/databases/:id"](request("8a1f0c2e-1d6b-4b8e-9b37-1f2d3c4b5a60")) as {
      status?: number
      body: { object: string; code: string }
    }

    expect(known.status ?? 200).toBe(200)
    expect(known.body.id).toBe("fake-notion-db-0001")
    expect(forged.status).toBe(404)
    expect(forged.body).toMatchObject({ object: "error", code: "object_not_found" })
  })
})
