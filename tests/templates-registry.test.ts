import { beforeEach, describe, expect, it, vi } from "vitest"

const store = vi.hoisted(() => ({
  loadCustomTemplate: vi.fn(),
  listCustomTemplates: vi.fn(),
}))

vi.mock("@/lib/ai/templates/store", () => store)

const { BUILT_IN_TEMPLATES, templateForMeetingType } = await import("@/lib/ai/templates/builtins")
const {
  isValidTemplateKey,
  listTemplates,
  requestedTemplateKey,
  resolveTemplate,
  selectTemplate,
} = await import("@/lib/ai/templates/registry")
const { buildSummarySchema, modelSections, validateSummaryOutput } = await import(
  "@/lib/ai/templates/schema"
)
const { BUILT_IN_TEMPLATE_KEYS } = await import("@/lib/ai/templates/types")

const custom = {
  id: "tpl_1",
  workspaceId: "ws_1",
  key: "acme-qbr",
  name: "Acme QBR",
  baseTemplate: "board_investor",
  prompt: "Focus on churn.",
  sections: [
    {
      key: "churn",
      title: { he: "נטישה", en: "Churn" },
      kind: "bullets" as const,
      instructions: "Churn signals.",
      maxItems: 2,
      required: true,
    },
  ],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
}

beforeEach(() => {
  store.loadCustomTemplate.mockReset().mockResolvedValue(undefined)
  store.listCustomTemplates.mockReset().mockResolvedValue([])
})

const emptyOutput = {
  overview: "x",
  sections: [] as Array<{ key: string; text?: string; items: Array<{ text: string; refs: string[] }> }>,
  decisions: [],
  risks: [],
  openQuestions: [],
  commitments: [],
  nextSteps: [],
  chapters: [],
  actionItems: [],
}

describe("template registry", () => {
  it("has the 7 M5 built-ins plus the legacy keys, each with sections", async () => {
    for (const key of BUILT_IN_TEMPLATE_KEYS) {
      const template = await resolveTemplate("ws_1", key)

      expect(template?.builtIn).toBe(true)
      expect(template?.sections.length).toBeGreaterThan(0)
      expect(template?.name.he).toBeTruthy()
    }
    expect(BUILT_IN_TEMPLATE_KEYS).toHaveLength(11)
  })

  it("hebrew_business has the Hebrew business sections", () => {
    expect(BUILT_IN_TEMPLATES.hebrew_business.sections.map((section) => section.title.he)).toEqual([
      "תקציר מנהלים",
      "החלטות",
      "משימות",
      "נקודות פתוחות",
      "סיכונים",
      "צעדים הבאים",
      "מספרים ותאריכים שהוזכרו",
    ])
    expect(modelSections(BUILT_IN_TEMPLATES.hebrew_business).map((section) => section.key)).toEqual([
      "numbers_dates",
    ])
  })

  it("merges a custom template over its base", async () => {
    store.loadCustomTemplate.mockResolvedValue(custom)

    const template = await resolveTemplate("ws_1", "custom:acme-qbr")

    expect(store.loadCustomTemplate).toHaveBeenCalledWith("ws_1", "acme-qbr")
    expect(template).toMatchObject({ key: "custom:acme-qbr", builtIn: false, name: { en: "Acme QBR" } })
    expect(template?.promptAddendum.en).toContain(BUILT_IN_TEMPLATES.board_investor.promptAddendum.en)
    expect(template?.promptAddendum.en).toContain("Focus on churn.")
    expect(template?.sections.map((section) => section.key)).toEqual(["churn"])
  })

  it("ignores archived, missing or failing custom templates", async () => {
    store.loadCustomTemplate.mockResolvedValueOnce({ ...custom, archivedAt: "2026-10-02T00:00:00Z" })
    expect(await resolveTemplate("ws_1", "custom:acme-qbr")).toBeUndefined()
    store.loadCustomTemplate.mockRejectedValueOnce(new Error("not implemented"))
    expect(await resolveTemplate("ws_1", "custom:acme-qbr")).toBeUndefined()
    expect(await resolveTemplate("ws_1", "nope")).toBeUndefined()
  })

  it("lists built-ins and active customs", async () => {
    store.listCustomTemplates.mockResolvedValue([custom, { ...custom, key: "old", archivedAt: "x" }])

    const keys = (await listTemplates("ws_1")).map((template) => template.key)

    expect(keys.slice(0, 11)).toEqual([...BUILT_IN_TEMPLATE_KEYS])
    expect(keys.slice(11)).toEqual(["custom:acme-qbr"])
  })

  it("validates keys and applies precedence: run, meeting, workspace, auto", () => {
    expect(isValidTemplateKey("general")).toBe(true)
    expect(isValidTemplateKey("real-estate")).toBe(true)
    expect(isValidTemplateKey("auto")).toBe(true)
    expect(isValidTemplateKey("custom:acme-qbr")).toBe(true)
    expect(isValidTemplateKey("custom:Bad Key")).toBe(false)
    expect(isValidTemplateKey("anything")).toBe(false)

    expect(requestedTemplateKey({ override: "sales", meetingTemplateKey: "legal", workspaceTemplate: "product" })).toBe("sales")
    expect(requestedTemplateKey({ meetingTemplateKey: "legal", workspaceTemplate: "product" })).toBe("legal")
    expect(requestedTemplateKey({ workspaceTemplate: "product" })).toBe("product")
    expect(requestedTemplateKey({ meetingTemplateKey: "bogus" })).toBe("auto")
  })

  it("auto picks a built-in from the meeting type; Hebrew without a match uses hebrew_business", async () => {
    expect(templateForMeetingType("sales", "he")).toBe("sales")
    expect(templateForMeetingType("real_estate", "en")).toBe("real-estate")
    expect(templateForMeetingType("other", "he")).toBe("hebrew_business")
    expect(templateForMeetingType(undefined, "en")).toBe("general")
    expect((await selectTemplate("ws_1", "auto", { meetingType: "standup", language: "he" })).key).toBe("standup")
    expect((await selectTemplate("ws_1", "custom:missing", { language: "he" })).key).toBe("hebrew_business")
  })
})

describe("template output schema", () => {
  it("restricts section keys to the template's model sections", () => {
    const schema = buildSummarySchema(BUILT_IN_TEMPLATES.sales)

    expect(
      schema.safeParse({ ...emptyOutput, sections: [{ key: "pricing", items: [] }] }).success
    ).toBe(true)
    expect(
      schema.safeParse({ ...emptyOutput, sections: [{ key: "decisions", items: [] }] }).success
    ).toBe(false)
  })

  it("enforces maxItems and required sections in validate()", async () => {
    store.loadCustomTemplate.mockResolvedValue(custom)
    const template = (await resolveTemplate("ws_1", "custom:acme-qbr"))!
    const validate = validateSummaryOutput(template)
    const item = { text: "t", refs: [] }

    expect(validate(emptyOutput)).toEqual(["sections.churn: required section is missing"])
    expect(
      validate({ ...emptyOutput, sections: [{ key: "churn", items: [item, item, item] }] })
    ).toEqual(["sections.churn: at most 2 items (got 3)"])
    expect(validate({ ...emptyOutput, sections: [{ key: "churn", items: [item] }] })).toEqual([])
  })
})
