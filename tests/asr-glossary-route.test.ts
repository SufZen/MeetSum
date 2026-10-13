import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { jsonRequest, routeParams } from "./helpers/route-ctx"
import { testAuthContext, testAuthState } from "./helpers/auth-context"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const { mockAuthzModule } = await import("./helpers/auth-context")

  return mockAuthzModule(importOriginal)
})

const recordAuditLog = vi.hoisted(() => vi.fn(async () => undefined))
const getAsrGlossary = vi.hoisted(() => vi.fn())
const updateAsrGlossary = vi.hoisted(() => vi.fn())

vi.mock("@/lib/audit", () => ({ recordAuditLog }))
vi.mock("@/lib/settings/asr-glossary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings/asr-glossary")>()

  return { ...actual, getAsrGlossary, updateAsrGlossary }
})

import { GET, PUT } from "@/app/api/asr/glossary/route"
import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr"
import type { WorkspaceRole } from "@/lib/workspaces/types"

const URL = "http://localhost/api/asr/glossary"
const workspaceTerms = [{ term: "Lisboa Riverside", aliases: ["ליסבואה ריברסייד"], hotword: true }]

function as(role: WorkspaceRole) {
  testAuthState.ctx = testAuthContext({ role, workspaceId: "ws_1" })
}

const put = (body: unknown) => PUT(jsonRequest(URL, "PUT", body), routeParams({}))

beforeAll(() => {
  process.env.MEETSUM_RATE_LIMIT = "false"
})

beforeEach(() => {
  testAuthState.ctx = undefined
  testAuthState.permissions = []
  recordAuditLog.mockClear()
  getAsrGlossary.mockReset()
  updateAsrGlossary.mockReset()
  getAsrGlossary.mockImplementation(async () => ({
    version: 1,
    terms: [...DEFAULT_ASR_GLOSSARY.terms, ...workspaceTerms],
  }))
  updateAsrGlossary.mockImplementation(async (_workspaceId: string, glossary: unknown) => glossary)
})

describe("GET /api/asr/glossary", () => {
  it("returns the effective glossary, the defaults and the limits to a viewer", async () => {
    as("viewer")

    const response = await GET(new Request(URL), routeParams({}))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(testAuthState.permissions).toEqual(["workspace:read"])
    expect(getAsrGlossary).toHaveBeenCalledWith("ws_1")
    expect(body.glossary.terms).toHaveLength(DEFAULT_ASR_GLOSSARY.terms.length + 1)
    expect(body.defaults).toEqual(DEFAULT_ASR_GLOSSARY)
    expect(body.limits).toEqual({ maxTerms: 300, maxChars: 64, maxAliases: 10 })
  })

  it("answers 401 without a session", async () => {
    const response = await GET(new Request(URL), routeParams({}))

    expect(response.status).toBe(401)
  })
})

describe("PUT /api/asr/glossary", () => {
  it("validates, stores and audits the workspace terms", async () => {
    as("admin")

    const response = await put({
      version: 1,
      terms: [{ term: "  Lisboa   Riverside ", aliases: ["ליסבואה ריברסייד"], hotword: false }],
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(testAuthState.permissions).toEqual(["settings:write"])
    expect(updateAsrGlossary).toHaveBeenCalledWith("ws_1", {
      version: 1,
      terms: [{ term: "Lisboa Riverside", aliases: ["ליסבואה ריברסייד"], hotword: false }],
    })
    expect(body.glossary.terms[0].term).toBe("Lisboa Riverside")
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "asr.glossary.updated",
        workspaceId: "ws_1",
        targetId: "ws_1",
        metadata: { terms: 1, hotwords: 0 },
      })
    )
  })

  it("accepts a {glossary} envelope", async () => {
    as("owner")

    const response = await put({ glossary: { terms: [{ term: "Gemma", aliases: [] }] } })

    expect(response.status).toBe(200)
    expect(updateAsrGlossary).toHaveBeenCalledWith("ws_1", {
      version: 1,
      terms: [{ term: "Gemma", aliases: [], hotword: true }],
    })
  })

  it("answers 400 with field errors for limit violations", async () => {
    as("admin")

    const tooLong = await put({ terms: [{ term: "x".repeat(65), aliases: [] }] })
    const tooManyAliases = await put({
      terms: [{ term: "a", aliases: Array.from({ length: 11 }, (_, i) => `alias ${i}`) }],
    })
    const tooManyTerms = await put({
      terms: Array.from({ length: 301 }, (_, i) => ({ term: `term ${i}`, aliases: [] })),
    })

    expect(tooLong.status).toBe(400)
    expect(await tooLong.json()).toEqual({
      error: "Invalid glossary",
      fieldErrors: [{ path: "terms.0.term", message: "must be at most 64 characters" }],
    })
    expect((await tooManyAliases.json()).fieldErrors[0].path).toBe("terms.0.aliases")
    expect((await tooManyTerms.json()).fieldErrors[0]).toEqual({
      path: "terms",
      message: "must have at most 300 terms",
    })
    expect(updateAsrGlossary).not.toHaveBeenCalled()
    expect(recordAuditLog).not.toHaveBeenCalled()
  })

  it("answers 400 for a malformed body", async () => {
    as("admin")

    const response = await PUT(
      new Request(URL, { method: "PUT", body: "not json", headers: { "content-type": "application/json" } }),
      routeParams({})
    )

    expect(response.status).toBe(400)
  })

  it.each(["viewer", "member"] as const)("answers 403 for a %s", async (role) => {
    as(role)

    const response = await put({ terms: [] })

    expect(response.status).toBe(403)
    expect(updateAsrGlossary).not.toHaveBeenCalled()
  })
})
