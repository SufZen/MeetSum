import { beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const generateStructured = vi.hoisted(() => vi.fn())

vi.mock("@/lib/ai/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/llm")>()

  return { ...actual, generateStructured }
})

import { GET, POST } from "@/app/api/meetings/[id]/follow-up/route"
import type { LlmStructuredRequest } from "@/lib/ai/llm"
import {
  actionItemLines,
  FollowUpUnavailableError,
  generateFollowUpEmail,
  listFollowUpVariants,
  type FollowUpOutput,
} from "@/lib/intelligence/follow-up"
import { resetMemoryGeneratedDocs } from "@/lib/intelligence/prep/generated-docs"
import { createInMemoryMeetingDatabase, type MeetingRecord, type RepoScope } from "@/lib/meetings/repository"

const scope: RepoScope = { kind: "member", workspaceId: "ws_a", userId: "user_me", email: "me@x.co", role: "member" }

const meeting: MeetingRecord = testMeeting({
  id: "m_1",
  title: "סטטוס פרויקט",
  startedAt: "2026-10-15T09:00:00.000Z",
  summary: {
    overview: "עברנו על הסטטוס של ה-API.",
    decisions: ["משיקים ב-1.11"],
    actionItems: [
      { id: "a1", title: "לעדכן את ה-README", owner: "דנה", status: "open", dueOn: "2026-10-18" },
      { id: "a2", title: "לבדוק את ה-PR", status: "open" },
      { id: "a3", title: "כבר בוצע", status: "done" },
    ],
  },
})

function answer(request: LlmStructuredRequest<FollowUpOutput>) {
  const he = request.language === "he"

  return {
    value: {
      subject: he ? "סיכום פגישה — סטטוס פרויקט" : "Recap — project status",
      greeting: he ? "שלום לכולם," : "Hi all,",
      body: he ? "תודה על הפגישה. הוחלט להשיק ב-01.11.2026." : "Thanks for the meeting.",
      closing: he ? "בברכה," : "Best,",
    },
    provider: "gemini",
    model: "gemini-3.5-flash",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: null,
    latencyMs: 1,
    attempts: [],
    fallbackUsed: false,
    aiRunId: "run_fu",
  }
}

beforeEach(() => {
  resetMemoryGeneratedDocs()
  generateStructured.mockReset()
  generateStructured.mockImplementation(async (request) => answer(request))
})

describe("actionItemLines", () => {
  it("lists open items as owner — task — due, localized", () => {
    expect(actionItemLines(meeting, "he")).toEqual([
      "- דנה — לעדכן את ה-README — 18.10.2026",
      "- ללא אחראי — לבדוק את ה-PR",
    ])
    expect(actionItemLines(meeting, "en")[1]).toBe("- Unassigned — לבדוק את ה-PR")
  })
})

describe("generateFollowUpEmail", () => {
  it("assembles the model prose with the stored action items", async () => {
    const variant = await generateFollowUpEmail(scope, meeting, {
      language: "he",
      tone: "formal",
      includeActionItems: true,
    })
    const request = generateStructured.mock.calls[0][0] as LlmStructuredRequest<FollowUpOutput>

    expect(request).toMatchObject({ task: "follow_up", language: "he", ctx: { promptVersion: "m5.followup.1" } })
    expect(request.instructions).toContain("ניסוח ניטרלי מגדרית")
    expect(request.instructions).toContain("טון רשמי")
    expect(request.instructions).toContain("משיקים ב-1.11")
    expect(variant.variant).toBe("he:formal")
    expect(variant.subject).toBe("סיכום פגישה — סטטוס פרויקט")
    expect(variant.bodyText).toBe(
      [
        "שלום לכולם,",
        "תודה על הפגישה. הוחלט להשיק ב-01.11.2026.",
        "משימות להמשך:\n- דנה — לעדכן את ה-README — 18.10.2026\n- ללא אחראי — לבדוק את ה-PR",
        "בברכה,",
      ].join("\n\n")
    )
  })

  it("covers he/en and all three tones as separate cached variants", async () => {
    for (const language of ["he", "en"] as const) {
      for (const tone of ["formal", "friendly", "concise"] as const) {
        await generateFollowUpEmail(scope, meeting, { language, tone, includeActionItems: false })
      }
    }

    const variants = await listFollowUpVariants(scope, meeting)

    expect(variants.map((variant) => variant.variant)).toEqual([
      "en:concise",
      "en:formal",
      "en:friendly",
      "he:concise",
      "he:formal",
      "he:friendly",
    ])
    expect(variants.find((variant) => variant.variant === "en:formal")?.bodyText).not.toContain("Action items")
    expect(generateStructured).toHaveBeenCalledTimes(6)
  })

  it("caches by input hash: same inputs hit, changed inputs or force regenerate", async () => {
    const options = { language: "he" as const, tone: "concise" as const, includeActionItems: true }

    await generateFollowUpEmail(scope, meeting, options)
    const hit = await generateFollowUpEmail(scope, meeting, options)

    expect(hit.cached).toBe(true)
    expect(generateStructured).toHaveBeenCalledTimes(1)

    await generateFollowUpEmail(scope, meeting, { ...options, recipients: ["dana@x.co"] })
    expect(generateStructured).toHaveBeenCalledTimes(2)
    await generateFollowUpEmail(scope, { ...meeting, title: "כותרת אחרת" }, { ...options, recipients: ["dana@x.co"] })
    expect(generateStructured).toHaveBeenCalledTimes(3)
    await generateFollowUpEmail(scope, { ...meeting, title: "כותרת אחרת" }, { ...options, recipients: ["dana@x.co"], force: true })
    expect(generateStructured).toHaveBeenCalledTimes(4)
  })

  it("refuses a meeting with nothing to follow up on", async () => {
    await expect(
      generateFollowUpEmail(scope, testMeeting({ id: "m_empty" }), { language: "he", tone: "formal", includeActionItems: true })
    ).rejects.toBeInstanceOf(FollowUpUnavailableError)
  })
})

describe("/api/meetings/:id/follow-up", () => {
  async function ctx(role: "viewer" | "member" = "viewer") {
    setRouteCtx(
      await createTestCtx({
        role,
        database: createInMemoryMeetingDatabase([
          meeting,
          testMeeting({ id: "m_empty" }),
          testMeeting({ id: "m_foreign", workspaceId: "ws_b", summary: meeting.summary }),
        ]),
      })
    )
  }

  it("generates for a viewer and lists variants", async () => {
    await ctx()

    const response = await POST(
      jsonRequest("http://x", "POST", { language: "en", tone: "friendly" }),
      routeParams({ id: "m_1" })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.variant.variant).toBe("en:friendly")
    expect(body.mailtoMaxBodyChars).toBe(1800)
    const list = await (await GET(new Request("http://x"), routeParams({ id: "m_1" }))).json()

    expect(list.variants).toHaveLength(1)
  })

  it("validates input, 409s empty meetings and 404s invisible ones", async () => {
    await ctx("member")

    const bad = (body: unknown) => POST(jsonRequest("http://x", "POST", body), routeParams({ id: "m_1" }))

    expect((await bad({ language: "fr" })).status).toBe(400)
    expect((await bad({ tone: "angry" })).status).toBe(400)
    expect((await bad({ includeActionItems: "yes" })).status).toBe(400)
    expect((await bad({ recipients: "a@b.c" })).status).toBe(400)
    expect((await POST(jsonRequest("http://x", "POST", {}), routeParams({ id: "m_empty" }))).status).toBe(409)
    expect((await POST(jsonRequest("http://x", "POST", {}), routeParams({ id: "m_foreign" }))).status).toBe(404)
    expect((await GET(new Request("http://x"), routeParams({ id: "m_foreign" }))).status).toBe(404)
  })
})
