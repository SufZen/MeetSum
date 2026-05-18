import { describe, expect, it } from "vitest"

import { extractSmartTasks } from "@/lib/intelligence"
import type { TranscriptSegment } from "@/lib/meetings/repository"

function segment(text: string, overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: `seg_${Math.random().toString(36).slice(2, 8)}`,
    speaker: "Speaker A",
    startMs: 10000,
    endMs: 15000,
    text,
    ...overrides,
  }
}

describe("task extraction validation", () => {
  it("extracts explicit tasks with action verbs", () => {
    const tasks = extractSmartTasks([
      segment("We need to prepare the quarterly budget report by Friday."),
      segment("Please schedule a follow up meeting with the design team."),
    ])

    expect(tasks.length).toBeGreaterThanOrEqual(2)
    expect(tasks[0].title).toContain("prepare")
    expect(tasks[1].title).toContain("schedule")
  })

  it("rejects bare 'send' without a clear object", () => {
    const tasks = extractSmartTasks([
      segment("I'll send you the link later, no worries about that."),
    ])

    // "send you the link later" should NOT match — "send" is followed by "you", not a deterministic object
    // But "send the link" would match. This segment's structure starts with "send you" which our
    // contextual pattern doesn't match. Let's verify it doesn't produce a task.
    // Actually "send you the" does contain "send ... the" but our pattern requires "send the/a/..." directly.
    expect(tasks).toHaveLength(0)
  })

  it("accepts 'send the report' as a valid task", () => {
    const tasks = extractSmartTasks([
      segment("Someone should send the report to the client before end of day."),
    ])

    expect(tasks.length).toBe(1)
    expect(tasks[0].title).toContain("send the report")
  })

  it("rejects questions even when they contain task verbs", () => {
    const tasks = extractSmartTasks([
      segment("Should we prepare the budget for next quarter?"),
    ])

    expect(tasks).toHaveLength(0)
  })

  it("rejects weak discussion fragments", () => {
    const tasks = extractSmartTasks([
      segment("Yeah I think we should probably look into that at some point."),
      segment("Uh so we need more info on that first."),
    ])

    expect(tasks).toHaveLength(0)
  })

  it("deduplicates similar task titles across segments", () => {
    const tasks = extractSmartTasks([
      segment("We need to prepare the client proposal for Tuesday."),
      segment("Right, we need to prepare the client proposal for Tuesday."),
    ])

    expect(tasks).toHaveLength(1)
  })

  it("extracts Hebrew task patterns", () => {
    const tasks = extractSmartTasks([
      segment("צריך להכין את הדוח לפני יום שלישי בבוקר."),
    ])

    expect(tasks.length).toBe(1)
    expect(tasks[0].title).toContain("צריך")
  })

  it("marks urgent tasks with higher confidence", () => {
    const tasks = extractSmartTasks([
      segment("We must fix this urgent production bug immediately before the release."),
    ])

    expect(tasks.length).toBe(1)
    expect(tasks[0].priority).toBe("urgent")
    expect(tasks[0].confidence).toBe(0.87)
  })

  it("caps extraction at 12 tasks", () => {
    const segments = Array.from({ length: 20 }, (_, index) =>
      segment(`We need to complete deliverable number ${index + 1} for the project.`, {
        id: `seg_${index}`,
      })
    )

    const tasks = extractSmartTasks(segments)

    expect(tasks.length).toBeLessThanOrEqual(12)
  })
})
