import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ insertAiRun: vi.fn() }))

vi.mock("@/lib/ai/llm/runs", () => ({ insertAiRun: mocks.insertAiRun }))

import { recordEmbeddingRun } from "@/lib/ai/embeddings/runs"

describe("recordEmbeddingRun", () => {
  it("writes an embedding ai_runs row with tokens, cost and id-only metadata", async () => {
    mocks.insertAiRun.mockResolvedValueOnce("airun_1")

    await expect(
      recordEmbeddingRun({
        workspaceId: "ws_1",
        meetingId: "m_1",
        jobId: "job_1",
        status: "completed",
        provider: "gemini",
        key: { model: "gemini-embedding-001", dimensions: 1536 },
        startedAt: 1_000,
        latencyMs: 250,
        inputTokens: 4_200,
        costUsd: 0.00063,
        metadata: { chunks: 12, embedded: 3, reused: 9, batches: 1, usageEstimated: true },
      })
    ).resolves.toBe("airun_1")

    expect(mocks.insertAiRun).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      meetingId: "m_1",
      jobId: "job_1",
      task: "embedding",
      status: "completed",
      provider: "gemini",
      model: "gemini-embedding-001:1536",
      startedAt: 1_000,
      latencyMs: 250,
      costEstimate: 0.00063,
      usage: { inputTokens: 4_200, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      metadata: { chunks: 12, embedded: 3, reused: 9, batches: 1, usageEstimated: true },
      error: undefined,
    })
  })

  it("records failures and never throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.insertAiRun.mockRejectedValueOnce(new Error("db down"))

    await expect(
      recordEmbeddingRun({
        workspaceId: "ws_1",
        status: "failed",
        provider: "gemini",
        key: { model: "gemini-embedding-001", dimensions: 1536 },
        startedAt: 1_000,
        inputTokens: 0,
        costUsd: null,
        metadata: { chunks: 4, embedded: 0, reused: 0, batches: 0, usageEstimated: true },
        error: "rate_limit",
      })
    ).resolves.toBeUndefined()
    expect(mocks.insertAiRun.mock.calls.at(-1)?.[0]).toMatchObject({ status: "failed", error: "rate_limit" })
    vi.restoreAllMocks()
  })
})
