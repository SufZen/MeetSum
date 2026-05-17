import { describe, expect, it } from "vitest"

import {
  buildMeetingIntelligence,
  cleanupTranscriptSegments,
  detectMeetingLanguages,
  extractSmartTasks,
  generateAutoTags,
} from "@/lib/intelligence"
import type { TranscriptSegment } from "@/lib/meetings/repository"

const segments: TranscriptSegment[] = [
  {
    id: "seg_1",
    speaker: "Ran",
    startMs: 0,
    endMs: 8200,
    text: "צריך לחבר את RealizeOS ל-MCP ולשמור את המספר 37.27.182.247 בלי לשנות.",
  },
  {
    id: "seg_2",
    speaker: "Maya",
    startMs: 8300,
    endMs: 16200,
    text: "We need a follow-up draft for the client and an urgent task for the product team.",
  },
  {
    id: "seg_3",
    speaker: "Leo",
    startMs: 16300,
    endMs: 22000,
    text: "Precisamos revisar o orçamento e enviar o resumo para o Google Drive.",
  },
]

describe("language intelligence", () => {
  it("detects Hebrew, English, Portuguese, and mixed meetings", () => {
    const metadata = detectMeetingLanguages(segments)

    expect(metadata.primaryLanguage).toBe("mixed")
    expect(metadata.mixedLanguage).toBe(true)
    expect(metadata.secondaryLanguages).toEqual(
      expect.arrayContaining(["he", "en", "pt"])
    )
    expect(metadata.segmentLanguages).toEqual([
      expect.objectContaining({ segmentId: "seg_1", language: "he" }),
      expect.objectContaining({ segmentId: "seg_2", language: "en" }),
      expect.objectContaining({ segmentId: "seg_3", language: "pt" }),
    ])
  })

  it("cleans repeated filler while preserving Hebrew, numbers, and technical terms", () => {
    const cleaned = cleanupTranscriptSegments([
      {
        id: "seg_1",
        speaker: "Ran",
        startMs: 0,
        endMs: 1000,
        text: "שומעים אותי? שומעים אותי?",
      },
      {
        id: "seg_2",
        speaker: "Ran",
        startMs: 1000,
        endMs: 2000,
        text: "צריך לבדוק את סופרבייס, ג'מיני ו-Claude Code ב-23/04 עם 17%.",
      },
      {
        id: "seg_3",
        speaker: "Ran",
        startMs: 2000,
        endMs: 3000,
        text: "צריך לבדוק את סופרבייס, ג'מיני ו-Claude Code ב-23/04 עם 17%.",
      },
    ])

    expect(cleaned).toHaveLength(1)
    expect(cleaned[0].text).toContain("Supabase")
    expect(cleaned[0].text).toContain("Gemini")
    expect(cleaned[0].text).toContain("Claude Code")
    expect(cleaned[0].text).toContain("23/04")
    expect(cleaned[0].text).toContain("17%")
  })

  it("generates business tags and language tags", () => {
    const tags = generateAutoTags(segments)

    expect(tags).toEqual(
      expect.arrayContaining([
        "technical",
        "finance",
        "product",
        "follow-up-needed",
        "urgent",
        "hebrew",
        "english",
        "portuguese",
        "mixed-language",
      ])
    )
  })

  it("extracts smart tasks with owner, priority, timestamp, and explicitness", () => {
    const tasks = extractSmartTasks(segments)

    expect(tasks[0]).toMatchObject({
      owner: "Ran",
      priority: "normal",
      sourceStartMs: 0,
      kind: "explicit",
    })
    expect(tasks.some((task) => task.priority === "urgent")).toBe(true)
  })

  it("does not turn ordinary discussion fragments into action items", () => {
    const tasks = extractSmartTasks([
      {
        id: "seg_discussion",
        speaker: "Ran",
        startMs: 0,
        endMs: 4000,
        text: "I think we should talk about the general model, but this is just context and not a task.",
      },
      {
        id: "seg_task",
        speaker: "Maya",
        startMs: 5000,
        endMs: 9000,
        text: "Please send the signed agreement to the investor by tomorrow.",
      },
    ])

    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      title: "Please send the signed agreement to the investor by tomorrow.",
      owner: "Maya",
      kind: "explicit",
    })
  })

  it("builds structured intelligence output for a meeting", () => {
    const intelligence = buildMeetingIntelligence({
      id: "meet_1",
      title: "Mixed language product review",
      source: "google_meet",
      language: "mixed",
      status: "completed",
      retention: "audio",
      startedAt: "2026-04-23T09:00:00.000Z",
      participants: ["Ran", "Maya", "Leo"],
      transcript: segments,
    })

    expect(intelligence.overview).toContain("Mixed language product review")
    expect(intelligence.actionItems.length).toBeGreaterThan(0)
    expect(intelligence.followUpDraft).toContain("Follow-up")
    expect(intelligence.timestampedQuotes[0]).toMatchObject({
      segmentId: "seg_1",
      startMs: 0,
    })
  })
})
