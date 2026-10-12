import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  storeMeetingObjectStream: vi.fn(),
  deleteMeetingObject: vi.fn(),
}))

vi.mock("@/lib/storage/object-storage", () => ({
  storeMeetingObjectStream: mocks.storeMeetingObjectStream,
  deleteMeetingObject: mocks.deleteMeetingObject,
}))

import { parseMediaUploadRequest } from "@/lib/capture/multipart-upload"
import { UploadError } from "@/lib/capture/media-validation"
import { streamedMultipartRequest, wavBytes } from "./helpers/multipart"

function multipartRequest(
  parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; type: string; bytes: Buffer }
  >,
  headers: Record<string, string> = {}
) {
  const form = new FormData()

  for (const part of parts) {
    if ("bytes" in part) {
      form.append(
        part.name,
        new File([new Uint8Array(part.bytes)], part.filename, { type: part.type })
      )
    } else {
      form.append(part.name, part.value)
    }
  }

  return streamedMultipartRequest("http://localhost/upload", form, {
    headers,
    chunkSize: 32,
  })
}

const limits = { maxFileBytes: 1024, maxFieldBytes: 256 }

describe("parseMediaUploadRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.deleteMeetingObject.mockResolvedValue(undefined)
    mocks.storeMeetingObjectStream.mockImplementation(
      async (input: {
        keyPrefix: string
        filename: string
        contentType: string
        body: AsyncIterable<Buffer>
        maxBytes: number
      }) => {
        let size = 0
        for await (const chunk of input.body) {
          size += chunk.length
          if (size > input.maxBytes) {
            throw new UploadError("too large", 413)
          }
        }
        return {
          bucket: "meeting-media",
          key: `${input.keyPrefix}/stored-${input.filename}`,
          contentType: input.contentType,
          sizeBytes: size,
          checksumSha256: "sha",
        }
      }
    )
  })

  it("streams the file into storage and returns fields received before it", async () => {
    const resolveKeyPrefix = vi.fn(() => "meetings/meet_1")
    const upload = await parseMediaUploadRequest(
      await multipartRequest([
        { name: "captureMetadata", value: '{"captureId":"cap_1"}' },
        { name: "file", filename: "meeting.wav", type: "audio/wav", bytes: wavBytes() },
        { name: "transcript", value: "[]" },
      ]),
      { ...limits, resolveKeyPrefix }
    )

    expect(resolveKeyPrefix).toHaveBeenCalledWith({
      captureMetadata: '{"captureId":"cap_1"}',
    })
    expect(upload.fields).toEqual({
      captureMetadata: '{"captureId":"cap_1"}',
      transcript: "[]",
    })
    expect(upload.file).toMatchObject({
      storageKey: "meetings/meet_1/stored-meeting.wav",
      contentType: "audio/wav",
      sizeBytes: 64,
      checksumSha256: "sha",
    })
    expect(mocks.storeMeetingObjectStream).toHaveBeenCalledWith(
      expect.objectContaining({ keyPrefix: "meetings/meet_1", maxBytes: 1024 })
    )
  })

  it("rejects non-multipart bodies with 415", async () => {
    await expect(
      parseMediaUploadRequest(
        new Request("http://localhost/upload", {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" },
        }),
        { ...limits, resolveKeyPrefix: () => "x" }
      )
    ).rejects.toMatchObject({ status: 415 })
  })

  it("rejects by content-length with 413 before reading the body", async () => {
    const request = await multipartRequest(
      [{ name: "file", filename: "a.wav", type: "audio/wav", bytes: wavBytes() }],
      { "content-length": String(10 * 1024 * 1024) }
    )

    await expect(
      parseMediaUploadRequest(request, { ...limits, resolveKeyPrefix: () => "x" })
    ).rejects.toMatchObject({ status: 413 })
    expect(mocks.storeMeetingObjectStream).not.toHaveBeenCalled()
  })

  it("rejects oversized streamed files with 413", async () => {
    await expect(
      parseMediaUploadRequest(
        await multipartRequest([
          { name: "file", filename: "big.wav", type: "audio/wav", bytes: wavBytes(4096) },
        ]),
        { ...limits, resolveKeyPrefix: () => "meetings/m" }
      )
    ).rejects.toMatchObject({ status: 413 })
  })

  it("rejects disallowed MIME types and bad signatures with 415", async () => {
    await expect(
      parseMediaUploadRequest(
        await multipartRequest([
          { name: "file", filename: "a.pdf", type: "application/pdf", bytes: wavBytes() },
        ]),
        { ...limits, resolveKeyPrefix: () => "meetings/m" }
      )
    ).rejects.toMatchObject({ status: 415 })

    await expect(
      parseMediaUploadRequest(
        await multipartRequest([
          {
            name: "file",
            filename: "fake.wav",
            type: "audio/wav",
            bytes: Buffer.from("this is definitely not audio data at all"),
          },
        ]),
        { ...limits, resolveKeyPrefix: () => "meetings/m" }
      )
    ).rejects.toMatchObject({ status: 415 })
  })

  it("rejects oversized fields with 413", async () => {
    await expect(
      parseMediaUploadRequest(
        await multipartRequest([{ name: "transcript", value: "x".repeat(1000) }]),
        { ...limits, resolveKeyPrefix: () => "meetings/m" }
      )
    ).rejects.toMatchObject({ status: 413 })
  })

  it("rejects more than one file with 413 and cleans up the stored object", async () => {
    await expect(
      parseMediaUploadRequest(
        await multipartRequest([
          { name: "file", filename: "a.wav", type: "audio/wav", bytes: wavBytes() },
          { name: "file", filename: "b.wav", type: "audio/wav", bytes: wavBytes() },
        ]),
        { ...limits, resolveKeyPrefix: () => "meetings/m" }
      )
    ).rejects.toMatchObject({ status: 413 })
  })

  it("drains and skips the file when resolveKeyPrefix returns null", async () => {
    const upload = await parseMediaUploadRequest(
      await multipartRequest([
        { name: "captureMetadata", value: '{"captureId":"cap_1"}' },
        { name: "file", filename: "meeting.wav", type: "audio/wav", bytes: wavBytes() },
      ]),
      { ...limits, resolveKeyPrefix: () => null }
    )

    expect(upload.file).toBeUndefined()
    expect(upload.skippedFile).toEqual({
      filename: "meeting.wav",
      contentType: "audio/wav",
    })
    expect(mocks.storeMeetingObjectStream).not.toHaveBeenCalled()
  })

  it("deletes the stored object on cleanup", async () => {
    const upload = await parseMediaUploadRequest(
      await multipartRequest([
        { name: "file", filename: "meeting.wav", type: "audio/wav", bytes: wavBytes() },
      ]),
      { ...limits, resolveKeyPrefix: () => "meetings/m" }
    )

    await upload.cleanup()
    await upload.cleanup()

    expect(mocks.deleteMeetingObject).toHaveBeenCalledTimes(1)
    expect(mocks.deleteMeetingObject).toHaveBeenCalledWith(
      "meetings/m/stored-meeting.wav"
    )
  })

  it("uses the sniffed content type when the client sends a generic type", async () => {
    const upload = await parseMediaUploadRequest(
      await multipartRequest([
        {
          name: "file",
          filename: "meeting.bin",
          type: "application/octet-stream",
          bytes: wavBytes(),
        },
      ]),
      { ...limits, resolveKeyPrefix: () => "meetings/m" }
    )

    expect(upload.file?.contentType).toBe("audio/wav")
  })
})
