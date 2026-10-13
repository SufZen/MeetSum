import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import meetingFixture from "./fixtures/intelligence/hebrew-meeting.json"
import outputFixture from "./fixtures/intelligence/hebrew-summary-output.json"

const enrich = vi.hoisted(() => ({ calls: [] as Array<{ items: unknown[]; ctx: unknown }> }))

vi.mock("@/lib/tasks/enrich", () => ({
  enrichActionItems: (items: unknown[], ctx: unknown) => {
    enrich.calls.push({ items, ctx })
    return items
  },
}))

const { LlmError, setLlmProvidersForTesting } = await import("@/lib/ai/llm")
const { DEFAULT_APP_SETTINGS } = await import("@/lib/settings/app-settings")
const { runIntelligencePipeline } = await import("@/lib/intelligence/pipeline")

import type { LlmProvider, LlmStructuredRequest } from "@/lib/ai/llm"
import type { MeetingRecord } from "@/lib/meetings/repository"

type Handler = (req: LlmStructuredRequest<unknown>, model: string) => unknown

function provider(id: "anthropic" | "gemini", handler: Handler, configured = true) {
  const generate = vi.fn(async (req: LlmStructuredRequest<unknown>, model: string) => {
    const value = handler(req, model)

    if (value instanceof Error) throw value
    return {
      value: req.schema.zod.parse(value),
      provider: id,
      model,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.001,
      latencyMs: 5,
    }
  })

  return { id, isConfigured: () => configured, generate } as LlmProvider & {
    generate: typeof generate
  }
}

const meeting = () => structuredClone(meetingFixture.meeting) as unknown as MeetingRecord
// `auto`: the classified meeting type picks the template (Hebrew, no match: hebrew_business).
const settings = { ...DEFAULT_APP_SETTINGS, summaryTemplate: "auto" }

function standardHandler(summary: unknown = outputFixture.summary): Handler {
  return (req) => (req.task === "title_tags_type" ? outputFixture.title : summary)
}

const englishSummary = {
  ...outputFixture.summary,
  overview: "The team reviewed the migration and agreed to move all customers by the end of the month.",
  decisions: [{ text: "Move all customers by the end of the month", refs: ["s3"] }],
  chapters: [{ title: "Update", startRef: "s1", summary: "Status update on the migration", bullets: [] }],
  sections: [],
  risks: [],
  openQuestions: [],
  nextSteps: [],
  actionItems: [],
}

beforeEach(() => {
  enrich.calls.length = 0
})

afterEach(() => {
  setLlmProvidersForTesting(undefined)
  delete process.env.MEETSUM_LLM_MAX_TRANSCRIPT_TOKENS
})

describe("intelligence pipeline (Gemini only)", () => {
  it("produces a Hebrew IntelligenceV2 with no Anthropic calls", async () => {
    const gemini = provider("gemini", standardHandler())
    const anthropic = provider("anthropic", () => new Error("must not be called"), false)

    setLlmProvidersForTesting({ gemini, anthropic })
    const { intelligence, run } = await runIntelligencePipeline(meeting(), { settings })

    expect(anthropic.generate).not.toHaveBeenCalled()
    expect(gemini.generate.mock.calls.map(([req, model]) => [req.task, model])).toEqual([
      ["title_tags_type", "gemini-3.5-flash-lite"],
      ["summary", "gemini-3.8-flash"],
    ])
    expect(intelligence.version).toBe(2)
    expect(intelligence.title).toBe("עדכון מעבר ל-Supabase ותקציב רבעוני")
    expect(intelligence.meetingType).toBe("other")
    expect(intelligence.topics).toEqual(["מעבר ל-Supabase", "תקציב", "ספקים"])
    expect(intelligence.tags).toEqual(expect.arrayContaining(["technical", "finance", "hebrew"]))
    expect(intelligence.generation).toMatchObject({
      provider: "gemini",
      model: "gemini-3.8-flash",
      promptVersion: "m5.1",
      templateKey: "hebrew_business",
      language: "he",
      languageCheck: "passed",
      fallbackUsed: false,
      costUsd: 0.002,
    })
    expect(run).toMatchObject({ provider: "gemini", templateKey: "hebrew_business", languageCheck: "passed" })
  })

  it("sends the transcript as the shared prefix and the Hebrew instructions separately", async () => {
    const gemini = provider("gemini", standardHandler())

    setLlmProvidersForTesting({ gemini, anthropic: provider("anthropic", () => null, false) })
    await runIntelligencePipeline(meeting(), { settings })

    const [titleReq, summaryReq] = gemini.generate.mock.calls.map(([req]) => req)

    expect(titleReq.sharedContext).toBe(summaryReq.sharedContext)
    expect(summaryReq.sharedContext).toContain("[s4 10:00 יואב] אני אשלח את הצעת המחיר ללקוח עד יום ראשון.")
    expect(summaryReq.instructions).toContain("תאריך הפגישה: יום חמישי, 15.10.2026")
    expect(summaryReq.ctx).toMatchObject({ meetingId: "meet_fixture_he", templateKey: "hebrew_business" })
  })

  it("resolves citations, drops unknown aliases and fabricated quotes", async () => {
    setLlmProvidersForTesting({
      gemini: provider("gemini", standardHandler()),
      anthropic: provider("anthropic", () => null, false),
    })
    const { intelligence } = await runIntelligencePipeline(meeting(), { settings })
    const items = intelligence.items ?? []

    expect(intelligence.decisions).toEqual(["מעבירים את כל הלקוחות ל-Supabase עד סוף החודש"])
    expect(items.find((item) => item.kind === "open_question")?.refs).toEqual([
      { segmentId: "seg_07", startMs: 1_800_000 },
    ])
    expect(items.find((item) => item.text.startsWith("העברת הלקוחות"))).toMatchObject({
      kind: "section_item",
      sectionKey: "numbers_dates",
      refs: [{ segmentId: "seg_03", startMs: 300_000 }],
    })
    for (const item of items) {
      expect(item.id).toMatch(/^si_[0-9a-f]{12}$/)
      for (const ref of item.refs) {
        expect(meetingFixture.meeting.transcript.some((segment) => segment.id === ref.segmentId)).toBe(true)
      }
    }

    const [sendQuote, reviewPr] = intelligence.actionItems

    expect(intelligence.actionItems).toHaveLength(2)
    expect(sendQuote).toMatchObject({
      title: "שליחת הצעת המחיר ללקוח",
      ownerText: "אני",
      dueText: "עד יום ראשון",
      dueDate: "2026-10-18",
      sourceSegmentId: "seg_04",
      sourceStartMs: 600_000,
      sourceQuote: "אשלח את הצעת המחיר ללקוח עד יום ראשון",
      priority: "high",
    })
    // Fabricated quote: the citation is dropped (no citation, no claim).
    expect(reviewPr.sourceSegmentId).toBeUndefined()
    expect(reviewPr.sourceQuote).toBe("")
    expect(reviewPr).not.toHaveProperty("ownerIsSourceSpeaker")
  })

  it("normalizes chapters and builds template sections", async () => {
    setLlmProvidersForTesting({
      gemini: provider("gemini", standardHandler()),
      anthropic: provider("anthropic", () => null, false),
    })
    const { intelligence } = await runIntelligencePipeline(meeting(), { settings })

    expect(intelligence.chapters?.map((chapter) => [chapter.title, chapter.startMs, chapter.startSegmentId])).toEqual([
      ["עדכון טכני", 2_000, "seg_01"],
      ["החלטות ותקציב", 300_000, "seg_03"],
      ["סיכונים", 1_200_000, "seg_06"],
      ["סיכום והמשך", 2_400_000, "seg_08"],
    ])
    expect(intelligence.chapters?.at(-1)?.endMs).toBe(2_430_000)
    expect(intelligence.sections?.map((section) => section.key)).toEqual([
      "overview",
      "decisions",
      "action_items",
      "open_questions",
      "risks",
      "next_steps",
      "numbers_dates",
    ])
    expect(intelligence.sections?.[0].text).toContain("Supabase")
    expect(intelligence.sections?.[6].itemIds).toHaveLength(2)
  })

  it("passes the enrichment context to Package B", async () => {
    setLlmProvidersForTesting({
      gemini: provider("gemini", standardHandler()),
      anthropic: provider("anthropic", () => null, false),
    })
    const members = [{ userId: "u1", email: "dana@example.com", name: "Dana" }]

    await runIntelligencePipeline(meeting(), { settings, members })

    expect(enrich.calls).toHaveLength(1)
    expect(enrich.calls[0].ctx).toMatchObject({
      meetingStartedAt: "2026-10-15T07:00:00.000Z",
      timeZone: "Asia/Jerusalem",
      members,
    })
    expect(enrich.calls[0].items[0]).toMatchObject({ ownerIsSourceSpeaker: true, sourceSpeakerId: "spk_yoav" })
  })
})

describe("language check", () => {
  it("retries an English summary for a Hebrew meeting with a corrective line", async () => {
    let summaryCalls = 0
    const gemini = provider("gemini", (req) => {
      if (req.task === "title_tags_type") return outputFixture.title
      summaryCalls += 1
      return summaryCalls === 1 ? englishSummary : outputFixture.summary
    })

    setLlmProvidersForTesting({ gemini, anthropic: provider("anthropic", () => null, false) })
    const { intelligence } = await runIntelligencePipeline(meeting(), { settings })
    const summaryReqs = gemini.generate.mock.calls.map(([req]) => req).filter((req) => req.task === "summary")

    expect(summaryReqs).toHaveLength(2)
    expect(summaryReqs[1].instructions).toContain("הפלט הקודם לא נכתב בעברית")
    expect(summaryReqs[1].sharedContext).toBe(summaryReqs[0].sharedContext)
    expect(intelligence.generation?.languageCheck).toBe("passed")
    expect(intelligence.overview).toContain("Supabase")
  })

  it("accepts and flags the output when the retry is still in the wrong language", async () => {
    setLlmProvidersForTesting({
      gemini: provider("gemini", standardHandler(englishSummary)),
      anthropic: provider("anthropic", () => null, false),
    })
    const { intelligence, run } = await runIntelligencePipeline(meeting(), { settings })

    expect(intelligence.generation?.languageCheck).toBe("failed")
    expect(run.languageCheck).toBe("failed")
    expect(intelligence.overview).toContain("The team reviewed")
  })
})

describe("fallbacks and routing", () => {
  it("falls back to the heuristic V2 when every route fails, keeping the AI title", async () => {
    setLlmProvidersForTesting({
      gemini: provider("gemini", (req) =>
        req.task === "title_tags_type" ? outputFixture.title : new LlmError("503", "server", "gemini", true)
      ),
      anthropic: provider("anthropic", () => null, false),
    })

    const { intelligence, run } = await runIntelligencePipeline(meeting(), { settings })

    expect(run).toMatchObject({ provider: "heuristic", model: "heuristic-v1", fallbackUsed: true })
    expect(run.fallbackReason).toContain("server")
    expect(intelligence.generation).toMatchObject({ provider: "heuristic", fallbackUsed: true })
    expect(intelligence.chapters).toBeUndefined()
    expect(intelligence.title).toBe("עדכון מעבר ל-Supabase ותקציב רבעוני")
    expect(run.costUsd).toBe(0.001)
  })

  it("uses Sonnet for the summary and Haiku for the title with only Anthropic configured", async () => {
    const anthropic = provider("anthropic", standardHandler())

    setLlmProvidersForTesting({ anthropic, gemini: provider("gemini", () => null, false) })
    const { run } = await runIntelligencePipeline(meeting(), { settings })

    expect(anthropic.generate.mock.calls.map(([req, model]) => [req.task, model])).toEqual([
      ["title_tags_type", "claude-haiku-5-5"],
      ["summary", "claude-sonnet-5-5"],
    ])
    expect(run.provider).toBe("anthropic")
  })

  it("honors the template override and the meeting template", async () => {
    const gemini = provider("gemini", standardHandler({ ...outputFixture.summary, sections: [] }))

    setLlmProvidersForTesting({ gemini, anthropic: provider("anthropic", () => null, false) })
    const overridden = await runIntelligencePipeline(meeting(), { settings, templateKey: "sales" })

    expect(overridden.run.templateKey).toBe("sales")
    expect(overridden.intelligence.sections?.map((section) => section.key)).toContain("pricing")

    const withMeetingTemplate = { ...meeting(), templateKey: "standup" }
    const fromMeeting = await runIntelligencePipeline(withMeetingTemplate, {
      settings: { ...settings, summaryTemplate: "legal" },
    })

    expect(fromMeeting.run.templateKey).toBe("standup")
  })

  it("forces English output through the language option", async () => {
    const gemini = provider("gemini", standardHandler(englishSummary))

    setLlmProvidersForTesting({ gemini, anthropic: provider("anthropic", () => null, false) })
    const { run } = await runIntelligencePipeline(meeting(), { settings, language: "en" })

    expect(run.language).toBe("en")
    expect(run.languageCheck).toBe("passed")
    expect(gemini.generate.mock.calls[1][0].instructions).toContain("Meeting date: Thursday, 15.10.2026")
  })

  it("map-reduces huge transcripts over 30-minute windows with global aliases", async () => {
    process.env.MEETSUM_LLM_MAX_TRANSCRIPT_TOKENS = "50"
    const gemini = provider("gemini", standardHandler())

    setLlmProvidersForTesting({ gemini, anthropic: provider("anthropic", () => null, false) })
    const { intelligence } = await runIntelligencePipeline(meeting(), { settings })
    const summaryReqs = gemini.generate.mock.calls.map(([req]) => req).filter((req) => req.task === "summary")

    expect(summaryReqs).toHaveLength(2)
    expect(summaryReqs[1].sharedContext).toContain("[s8 40:00 יואב]")
    expect(summaryReqs[1].sharedContext).not.toContain("[s1 ")
    expect(intelligence.decisions).toEqual(["מעבירים את כל הלקוחות ל-Supabase עד סוף החודש"])
  })

  it("returns the heuristic summary for a meeting without a transcript", async () => {
    const empty = { ...meeting(), transcript: [] }

    const { run } = await runIntelligencePipeline(empty, { settings })

    expect(run).toMatchObject({ provider: "heuristic", fallbackReason: "Meeting has no transcript" })
  })
})
