import { describe, expect, it } from "vitest"

import { redactAsrErrorMessage } from "@/lib/ai/asr/errors"

describe("redactAsrErrorMessage", () => {
  it("strips presigned query strings, bearer tokens and key params", () => {
    const message = redactAsrErrorMessage(
      'download failed for https://minio.example.com/meetsum/asr-handoff/a.ogg?X-Amz-Signature=abc123&X-Amz-Credential=key' +
        ' (Authorization: Bearer sk-live-SECRET) {"api_key":"sx-123"} token=tok_456'
    )

    expect(message).toContain("https://minio.example.com/meetsum/asr-handoff/a.ogg?[redacted]")
    expect(message).not.toMatch(/abc123|sk-live-SECRET|sx-123|tok_456/)
  })

  it("collapses long base64 blobs and caps the length", () => {
    const blob = "A".repeat(500)
    const message = redactAsrErrorMessage(`bad input ${blob} ${"x".repeat(400)}`)

    expect(message).toContain("[blob]")
    expect(message.length).toBeLessThanOrEqual(300)
  })
})
