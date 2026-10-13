import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { getHandoffMode, prepareAsrHandoff, storeAsrHandoff } from "@/lib/ai/asr/handoff"
import { getMeetingObjectPresignedUrl } from "@/lib/storage/object-storage"

const s3Env = {
  S3_ENDPOINT: "http://minio:9000",
  S3_PUBLIC_ENDPOINT: "https://media.example.com",
  S3_ACCESS_KEY: "test-access-key",
  S3_SECRET_KEY: "test-secret-key",
  S3_BUCKET: "meeting-media",
}

let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs = []
})

describe("getMeetingObjectPresignedUrl", () => {
  it("signs against the public endpoint host, not the internal one", async () => {
    const url = new URL(await getMeetingObjectPresignedUrl("asr-handoff/abc.ogg", 7200, { env: s3Env }))

    expect(url.host).toBe("media.example.com")
    expect(url.pathname).toBe("/meeting-media/asr-handoff/abc.ogg")
    expect(url.searchParams.get("X-Amz-Expires")).toBe("7200")
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/)
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host")
  })

  it("accepts an explicit public endpoint and clamps the TTL", async () => {
    const url = new URL(
      await getMeetingObjectPresignedUrl("k.ogg", 5, { env: s3Env, publicEndpoint: "https://cdn.example.org/" })
    )

    expect(url.host).toBe("cdn.example.org")
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60")
  })

  it("requires credentials and an endpoint", async () => {
    await expect(getMeetingObjectPresignedUrl("k", 60, { env: {} })).rejects.toThrow(/S3_PUBLIC_ENDPOINT/)
    await expect(
      getMeetingObjectPresignedUrl("k", 60, { env: { S3_PUBLIC_ENDPOINT: "https://x" } })
    ).rejects.toThrow(/S3_ACCESS_KEY/)
  })
})

describe("ASR media handoff", () => {
  async function audioFile(bytes = 1000) {
    const dir = await mkdtemp(path.join(tmpdir(), "asr-handoff-"))
    dirs.push(dir)
    const file = path.join(dir, "asr.ogg")

    await writeFile(file, Buffer.alloc(bytes, 1))
    return file
  }

  it("parses the handoff mode", () => {
    expect(getHandoffMode({})).toBe("auto")
    expect(getHandoffMode({ MEETSUM_ASR_MEDIA_HANDOFF: "Blob" })).toBe("blob")
    expect(getHandoffMode({ MEETSUM_ASR_MEDIA_HANDOFF: "presigned" })).toBe("presigned")
  })

  it("stores under asr-handoff/<uuid>.ogg, presigns with the TTL and cleans up", async () => {
    const put = vi.fn(async () => ({ bucket: "b", key: "k", contentType: "audio/ogg", sizeBytes: 1 }))
    const presign = vi.fn(async () => "https://media.example.com/meeting-media/asr-handoff/u1.ogg?sig")
    const remove = vi.fn(async () => undefined)
    const stored = await storeAsrHandoff("/tmp/asr.ogg", {
      env: { ...s3Env, MEETSUM_ASR_HANDOFF_URL_TTL_SECONDS: "900" },
      put,
      presign,
      remove,
      uuid: () => "u1",
    })

    expect(stored.key).toBe("asr-handoff/u1.ogg")
    expect(put).toHaveBeenCalledWith({ key: "asr-handoff/u1.ogg", path: "/tmp/asr.ogg", contentType: "audio/ogg" })
    expect(presign).toHaveBeenCalledWith("asr-handoff/u1.ogg", 900, expect.objectContaining({ publicEndpoint: "https://media.example.com" }))
    await stored.cleanup()
    expect(remove).toHaveBeenCalledWith("asr-handoff/u1.ogg")
  })

  it("auto mode uses a presigned URL when a public endpoint exists", async () => {
    const handoff = await prepareAsrHandoff("/tmp/asr.ogg", "runpod-ivrit", {
      env: s3Env,
      put: async () => ({ bucket: "b", key: "k", contentType: "audio/ogg", sizeBytes: 1 }),
      presign: async () => "https://media.example.com/x",
      remove: async () => undefined,
    })

    expect(handoff.type).toBe("url")
  })

  it("auto mode falls back to a base64 blob without a public endpoint", async () => {
    const file = await audioFile(10)
    const handoff = await prepareAsrHandoff(file, "runpod-ivrit", { env: {} })

    expect(handoff).toMatchObject({ type: "blob", data: Buffer.alloc(10, 1).toString("base64") })
  })

  it("rejects blobs above RUNPOD_MAX_BLOB_BYTES with a non-retryable config error", async () => {
    const file = await audioFile(2000)

    await expect(prepareAsrHandoff(file, "runpod-ivrit", { env: { RUNPOD_MAX_BLOB_BYTES: "1000" } })).rejects.toMatchObject({
      kind: "config",
      retryable: false,
    })
  })

  it("presigned mode without a public endpoint is a config error", async () => {
    await expect(
      prepareAsrHandoff("/tmp/x.ogg", "runpod-ivrit", { env: { MEETSUM_ASR_MEDIA_HANDOFF: "presigned" } })
    ).rejects.toMatchObject({ kind: "config" })
  })

  it("deletes the uploaded object if presigning fails", async () => {
    const remove = vi.fn(async () => undefined)

    await expect(
      storeAsrHandoff("/tmp/x.ogg", {
        env: s3Env,
        put: async () => ({ bucket: "b", key: "k", contentType: "audio/ogg", sizeBytes: 1 }),
        presign: async () => {
          throw new Error("sign failed")
        },
        remove,
        uuid: () => "u2",
      })
    ).rejects.toThrow("sign failed")
    expect(remove).toHaveBeenCalledWith("asr-handoff/u2.ogg")
  })
})
