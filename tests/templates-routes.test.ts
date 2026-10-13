import { beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const recordAuditLog = vi.hoisted(() => vi.fn(async () => undefined))
const enqueueMeetSumJob = vi.hoisted(() => vi.fn(async (name: string) => ({ id: "job_1", name })))

vi.mock("@/lib/audit", () => ({ recordAuditLog }))
vi.mock("@/lib/jobs/queue", () => ({ enqueueMeetSumJob }))

import { GET as listTemplates, POST as createTemplate } from "@/app/api/templates/route"
import {
  DELETE as archiveTemplate,
  GET as getTemplate,
  PATCH as patchTemplate,
} from "@/app/api/templates/[id]/route"
import { PATCH as setMeetingTemplate } from "@/app/api/meetings/[id]/template/route"
import { POST as runIntelligence } from "@/app/api/meetings/[id]/intelligence/run/route"
import { GET as getIntelligence } from "@/app/api/meetings/[id]/intelligence/route"
import { resetMemoryTemplates, saveCustomTemplate } from "@/lib/ai/templates/store"
import { createInMemoryMeetingRepository, type MeetingRecord } from "@/lib/meetings/repository"
import type { WorkspaceRole } from "@/lib/workspaces/types"

const URL = "http://localhost/api/templates"

const template = {
  key: "deal-review",
  name: "סקירת עסקה",
  baseTemplate: "hebrew_business",
  prompt: "התמקד/י בתנאים",
  sections: [{ key: "terms", title: { he: "תנאים", en: "Terms" }, kind: "bullets", instructions: "", required: true }],
}

const meetings: MeetingRecord[] = [
  testMeeting({
    id: "m_a",
    workspaceId: "ws_a",
    intelligence: {
      overview: "סקירה",
      decisions: ["ממשיכים"],
      actionItems: [],
      risks: [],
      openQuestions: [],
      commitments: [],
      followUpDraft: "",
      timestampedQuotes: [],
      tags: [],
      languageMetadata: { primaryLanguage: "he", secondaryLanguages: [], segmentLanguages: [], confidence: 1, mixedLanguage: false },
    },
  }),
  testMeeting({ id: "m_b", workspaceId: "ws_b" }),
]

const setTemplateSpy = vi.fn(async (id: string, key: string | null) => ({ ...meetings[0], id, templateKey: key ?? undefined }))

async function as(role: WorkspaceRole) {
  const repository = {
    ...createInMemoryMeetingRepository(meetings, { kind: "system", workspaceId: "ws_a" }),
    setMeetingTemplate: setTemplateSpy,
  }

  setRouteCtx(await createTestCtx({ role, workspaceId: "ws_a", repository }))
}

beforeEach(() => {
  resetMemoryTemplates()
  recordAuditLog.mockClear()
  enqueueMeetSumJob.mockClear()
  setTemplateSpy.mockClear()
})

describe("/api/templates", () => {
  it("lists built-ins and workspace templates with a builtIn flag to viewers", async () => {
    await saveCustomTemplate("ws_a", template as never, {})
    await saveCustomTemplate("ws_b", { ...template, key: "other-ws" } as never, {})
    await as("viewer")

    const body = await (await listTemplates(new Request(URL), routeParams({}))).json()
    const keys = body.templates.map((item: { key: string }) => item.key)

    expect(keys).toEqual(expect.arrayContaining(["general", "hebrew_business", "custom:deal-review"]))
    expect(keys).not.toContain("custom:other-ws")
    expect(body.templates.find((item: { key: string }) => item.key === "general").builtIn).toBe(true)
    expect(body.templates.find((item: { key: string }) => item.key === "custom:deal-review")).toMatchObject({
      builtIn: false,
      baseTemplate: "hebrew_business",
    })
    expect(body.custom).toHaveLength(1)
  })

  it("forbids viewers and members from writing", async () => {
    for (const role of ["viewer", "member"] as const) {
      await as(role)
      expect((await createTemplate(jsonRequest(URL, "POST", template), routeParams({}))).status).toBe(403)
      expect((await patchTemplate(jsonRequest(URL, "PATCH", {}), routeParams({ id: "x" }))).status).toBe(403)
      expect((await archiveTemplate(new Request(URL, { method: "DELETE" }), routeParams({ id: "x" }))).status).toBe(403)
    }
  })

  it("creates, updates and archives with audit entries (admin)", async () => {
    await as("admin")

    const created = await createTemplate(jsonRequest(URL, "POST", template), routeParams({}))
    const { template: saved } = await created.json()

    expect(created.status).toBe(201)
    expect(recordAuditLog).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "template.created", workspaceId: "ws_a", targetId: saved.id })
    )

    const patched = await patchTemplate(jsonRequest(URL, "PATCH", { name: "עסקאות" }), routeParams({ id: saved.id }))

    expect(patched.status).toBe(200)
    expect((await patched.json()).template).toMatchObject({ name: "עסקאות", key: "deal-review" })
    expect(recordAuditLog).toHaveBeenLastCalledWith(expect.objectContaining({ action: "template.updated" }))
    expect((await getTemplate(new Request(URL), routeParams({ id: saved.id }))).status).toBe(200)

    const archived = await archiveTemplate(new Request(URL, { method: "DELETE" }), routeParams({ id: saved.id }))

    expect((await archived.json()).template.archivedAt).toBeTruthy()
    expect(recordAuditLog).toHaveBeenLastCalledWith(expect.objectContaining({ action: "template.archived" }))
  })

  it("answers 400 with field errors, 409 for duplicate keys and 404 for unknown ids", async () => {
    await as("owner")

    const invalid = await createTemplate(jsonRequest(URL, "POST", { ...template, key: "Bad Key" }), routeParams({}))

    expect(invalid.status).toBe(400)
    expect((await invalid.json()).fieldErrors[0].path).toBe("key")
    await createTemplate(jsonRequest(URL, "POST", template), routeParams({}))
    expect((await createTemplate(jsonRequest(URL, "POST", template), routeParams({}))).status).toBe(409)
    expect((await patchTemplate(jsonRequest(URL, "PATCH", { name: "x" }), routeParams({ id: "tpl_nope" }))).status).toBe(404)
    expect((await archiveTemplate(new Request(URL, { method: "DELETE" }), routeParams({ id: "tpl_nope" }))).status).toBe(404)
    expect(recordAuditLog).toHaveBeenCalledTimes(1)
  })

  it("answers 409 when a PATCH changes the key", async () => {
    await as("owner")

    const created = await createTemplate(jsonRequest(URL, "POST", template), routeParams({}))
    const { template: saved } = (await created.json()) as { template: { id: string; key: string } }
    const renamed = await patchTemplate(jsonRequest(URL, "PATCH", { key: "another-key" }), routeParams({ id: saved.id }))

    expect(renamed.status).toBe(409)
    expect(await renamed.json()).toEqual({ error: "template_key_immutable" })
    expect(
      (await patchTemplate(jsonRequest(URL, "PATCH", { key: saved.key, name: "x" }), routeParams({ id: saved.id }))).status
    ).toBe(200)
  })
})

describe("PATCH /api/meetings/:id/template", () => {
  const patch = (id: string, body: unknown) =>
    setMeetingTemplate(jsonRequest(`http://x/api/meetings/${id}/template`, "PATCH", body), routeParams({ id }))

  it("sets a built-in, custom or null template and audits the change", async () => {
    await saveCustomTemplate("ws_a", template as never, {})
    await as("member")

    expect((await patch("m_a", { templateKey: "sales" })).status).toBe(200)
    expect((await patch("m_a", { templateKey: "custom:deal-review" })).status).toBe(200)
    const cleared = await patch("m_a", { templateKey: null })

    expect(await cleared.json()).toEqual({ meeting: { id: "m_a", templateKey: null } })
    expect(setTemplateSpy.mock.calls.map((call) => call[1])).toEqual(["sales", "custom:deal-review", null])
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "meeting.template.changed", targetId: "m_a", workspaceId: "ws_a" })
    )
  })

  it("rejects viewers, unknown templates and invisible meetings", async () => {
    await as("viewer")
    expect((await patch("m_a", { templateKey: "sales" })).status).toBe(403)

    await as("member")
    expect((await patch("m_a", { templateKey: "custom:nope" })).status).toBe(400)
    expect((await patch("m_a", { templateKey: 7 })).status).toBe(400)
    expect((await patch("m_b", { templateKey: "sales" })).status).toBe(404)
    expect(setTemplateSpy).not.toHaveBeenCalled()
  })
})

describe("/api/meetings/:id/intelligence", () => {
  const run = (id: string, body?: unknown) =>
    runIntelligence(jsonRequest(`http://x/api/meetings/${id}/intelligence/run`, "POST", body), routeParams({ id }))

  it("passes templateKey and language through to meeting.summarize", async () => {
    await as("member")

    expect((await run("m_a", { templateKey: "hebrew_business", language: "he" })).status).toBe(202)
    expect(enqueueMeetSumJob).toHaveBeenCalledWith("meeting.summarize", {
      meetingId: "m_a",
      workspaceId: "ws_a",
      templateKey: "hebrew_business",
      language: "he",
    })
    expect((await run("m_a")).status).toBe(202)
    expect(enqueueMeetSumJob).toHaveBeenLastCalledWith("meeting.summarize", { meetingId: "m_a", workspaceId: "ws_a" })
  })

  it("validates the overrides", async () => {
    await as("member")

    expect((await run("m_a", { templateKey: "nope" })).status).toBe(400)
    expect((await run("m_a", { language: "fr" })).status).toBe(400)
    expect((await run("m_b", {})).status).toBe(404)
    expect(enqueueMeetSumJob).not.toHaveBeenCalled()
  })

  it("returns normalized V2 intelligence", async () => {
    await as("viewer")

    const body = await (await getIntelligence(new Request("http://x"), routeParams({ id: "m_a" }))).json()

    expect(body.intelligence.decisions).toEqual(["ממשיכים"])
    expect(body.intelligence.items[0]).toMatchObject({ kind: "decision", text: "ממשיכים" })
    expect(body.intelligence.items[0].id).toMatch(/^si_[0-9a-f]{12}$/)
  })
})
