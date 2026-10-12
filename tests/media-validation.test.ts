import { createHash } from "node:crypto"
import { Readable, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { afterEach, describe, expect, it, vi } from "vitest"

const s3 = vi.hoisted(() => ({
  send: vi.fn(async () => ({})),
  uploads: [] as Array<{ params: { Key: string; Body: AsyncIterable<Buffer> }; options: Record<string, unknown> }>,
  aborted: 0,
}))

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(readonly input: unknown) {}
  }
  return {
    S3Client: class {
      send = s3.send
    },
    CreateBucketCommand: Command,
    GetObjectCommand: Command,
    HeadBucketCommand: Command,
    PutObjectCommand: Command,
    DeleteObjectCommand: Command,
  }
})

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    private readonly options: { params: { Key: string; Body: AsyncIterable<Buffer> } } & Record<string, unknown>
    constructor(options: { params: { Key: string; Body: AsyncIterable<Buffer> } } & Record<string, unknown>) {
      this.options = options
      s3.uploads.push({ params: options.params, options })
    }
    async done() {
      let size = 0
      for await (const chunk of this.options.params.Body) size += chunk.length
      return { size }
    }
    async abort() {
      s3.aborted += 1
    }
  },
}))

import {
  UploadError,
  UploadTooLargeError,
  assertSupportedMedia,
  getUploadLimits,
  isAllowedMediaType,
  retentionForContentType,
  sniffMediaSignature,
} from "@/lib/capture/media-validation"
import {
  CountingHashTransform,
  storeMeetingObjectStream,
} from "@/lib/storage/object-storage"

function bytes(...parts: Array<string | number[]>) {
  return Buffer.concat(
    parts.map((part) =>
      typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part)
    )
  )
}

describe("upload limits", () => {
  it("defaults to 2 GiB uploads and 5 MiB fields", () => {
    expect(getUploadLimits({} as NodeJS.ProcessEnv)).toEqual({
      maxUploadBytes: 2 * 1024 ** 3,
      maxFieldBytes: 5 * 1024 ** 2,
      maxRecordingBytes: 2 * 1024 ** 3,
    })
  })

  it("reads overrides and ignores invalid values", () => {
    expect(
      getUploadLimits({
        MEETSUM_MAX_UPLOAD_BYTES: "1000",
        MEETSUM_MAX_UPLOAD_FIELD_BYTES: "nope",
        MEETSUM_MAX_RECORDING_BYTES: "5000",
      } as unknown as NodeJS.ProcessEnv)
    ).toEqual({
      maxUploadBytes: 1000,
      maxFieldBytes: 5 * 1024 ** 2,
      maxRecordingBytes: 5000,
    })
  })
})

describe("media type allow-list", () => {
  it("accepts audio/video and generic binary types", () => {
    expect(isAllowedMediaType("audio/webm;codecs=opus")).toBe(true)
    expect(isAllowedMediaType("video/mp4")).toBe(true)
    expect(isAllowedMediaType("application/octet-stream")).toBe(true)
  })

  it("rejects documents, images and missing types", () => {
    expect(isAllowedMediaType("application/pdf")).toBe(false)
    expect(isAllowedMediaType("image/png")).toBe(false)
    expect(isAllowedMediaType("text/html")).toBe(false)
    expect(isAllowedMediaType(undefined)).toBe(false)
  })
})

describe("media signature sniffing", () => {
  it.each([
    ["mp4", bytes([0, 0, 0, 0x20], "ftypisom", [0, 0, 0, 0]), "iso-bmff", "video/mp4"],
    ["m4a", bytes([0, 0, 0, 0x20], "ftypM4A ", [0, 0, 0, 0]), "iso-bmff", "audio/mp4"],
    ["webm", bytes([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]), "ebml", "video/webm"],
    ["ogg", bytes("OggS", [0, 2, 0, 0]), "ogg", "audio/ogg"],
    ["wav", bytes("RIFF", [0, 0, 0, 0], "WAVE"), "wave", "audio/wav"],
    ["mp3 id3", bytes("ID3", [3, 0, 0]), "mpeg", "audio/mpeg"],
    ["mp3 frame", bytes([0xff, 0xfb, 0x90, 0x64]), "mpeg", "audio/mpeg"],
    ["flac", bytes("fLaC", [0, 0, 0, 0x22]), "flac", "audio/flac"],
    ["adts", bytes([0xff, 0xf1, 0x50, 0x80]), "adts", "audio/aac"],
    ["amr", bytes("#!AMR\n"), "amr", "audio/amr"],
  ])("detects %s", (_name, head, kind, contentType) => {
    expect(sniffMediaSignature(head)).toEqual({ kind, contentType })
  })

  it("rejects non-media content", () => {
    expect(sniffMediaSignature(bytes("%PDF-1.7 hello"))).toBeUndefined()
    expect(sniffMediaSignature(bytes("RIFF", [0, 0, 0, 0], "AVI "))).toBeUndefined()
    expect(sniffMediaSignature(bytes([0x89], "PNG\r\n"))).toBeUndefined()
    expect(sniffMediaSignature(new Uint8Array())).toBeUndefined()
  })

  it("assertSupportedMedia returns the sniffed type for generic uploads and 415 otherwise", () => {
    const wav = bytes("RIFF", [0, 0, 0, 0], "WAVE")

    expect(assertSupportedMedia("application/octet-stream", wav)).toBe("audio/wav")
    expect(assertSupportedMedia("audio/x-wav", wav)).toBe("audio/x-wav")
    expect(() => assertSupportedMedia("image/png", wav)).toThrow(UploadError)
    expect(() => assertSupportedMedia("audio/wav", bytes("not audio"))).toThrow(
      expect.objectContaining({ status: 415 })
    )
  })

  it("derives retention from the content type", () => {
    expect(retentionForContentType("video/webm")).toBe("video")
    expect(retentionForContentType("audio/mp4")).toBe("audio")
  })
})

describe("counting + hashing transform", () => {
  it("passes data through, counts bytes and computes sha256", async () => {
    const counter = new CountingHashTransform(100)
    const chunks: Buffer[] = []

    await pipeline(
      Readable.from([Buffer.from("hello "), Buffer.from("world")]),
      counter,
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk)
          callback()
        },
      })
    )

    expect(Buffer.concat(chunks).toString()).toBe("hello world")
    expect(counter.bytes).toBe(11)
    expect(counter.digest()).toBe(
      createHash("sha256").update("hello world").digest("hex")
    )
  })

  it("throws UploadTooLargeError past the limit", async () => {
    const counter = new CountingHashTransform(4)

    await expect(
      pipeline(
        Readable.from([Buffer.from("abc"), Buffer.from("def")]),
        counter,
        new Writable({ write: (_c, _e, cb) => cb() })
      )
    ).rejects.toBeInstanceOf(UploadTooLargeError)
  })
})

describe("storeMeetingObjectStream", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function stubS3() {
    vi.stubEnv("S3_ENDPOINT", "http://minio:9000")
    vi.stubEnv("S3_ACCESS_KEY", "key")
    vi.stubEnv("S3_SECRET_KEY", "secret")
  }

  it("streams a multipart upload (8 MiB parts, 2 in flight) and returns size + checksum", async () => {
    stubS3()
    s3.uploads.length = 0

    const stored = await storeMeetingObjectStream({
      keyPrefix: "meetings/_incoming/abc/",
      filename: "my meeting?.webm",
      contentType: "audio/webm",
      body: Readable.from([Buffer.from("chunk-1"), Buffer.from("chunk-2")]),
      maxBytes: 100,
    })

    expect(stored).toMatchObject({
      bucket: "meeting-media",
      contentType: "audio/webm",
      sizeBytes: 14,
      checksumSha256: createHash("sha256").update("chunk-1chunk-2").digest("hex"),
    })
    expect(stored.key).toMatch(/^meetings\/_incoming\/abc\/\d+-[0-9a-f-]{36}-my meeting_\.webm$/)
    expect(s3.uploads[0].options).toMatchObject({ partSize: 8 * 1024 * 1024, queueSize: 2 })
  })

  it("accepts web streams", async () => {
    stubS3()

    const stored = await storeMeetingObjectStream({
      keyPrefix: "meetings/m1",
      filename: "a.wav",
      contentType: "audio/wav",
      body: new Response("web-stream-bytes").body as ReadableStream<Uint8Array>,
      maxBytes: 100,
    })

    expect(stored.sizeBytes).toBe(16)
  })

  it("aborts and throws UploadTooLargeError past maxBytes", async () => {
    stubS3()

    await expect(
      storeMeetingObjectStream({
        keyPrefix: "meetings/m1",
        filename: "big.wav",
        contentType: "audio/wav",
        body: Readable.from([Buffer.alloc(60), Buffer.alloc(60)]),
        maxBytes: 100,
      })
    ).rejects.toBeInstanceOf(UploadTooLargeError)
  })
})
