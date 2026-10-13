import { beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const storage = vi.hoisted(() => ({ getMeetingObjectRange: vi.fn() }))

vi.mock("@/lib/storage/object-storage", () => storage)

import { GET as getPeaks } from "@/app/api/meetings/[id]/media/peaks/route"
import { GET, HEAD } from "@/app/api/meetings/[id]/media/route"
import type { MediaAsset } from "@/lib/meetings/repository"
import type { WorkspaceRole } from "@/lib/workspaces/types"

const SIZE = 20 * 1024 * 1024
const CREATED = "2026-10-01T10:00:00.000Z"

function asset(overrides: Partial<MediaAsset> & { id: string }): MediaAsset {
  return {
    meetingId: "m_a",
    storageKey: `meetings/m_a/${overrides.id}.m4a`,
    contentType: "audio/mp4",
    sizeBytes: SIZE,
    retention: "audio",
    kind: "original",
    checksumSha256: "0123456789abcdef",
    createdAt: CREATED,
    ...overrides,
  }
}

const original = asset({
  id: "asset_orig",
  contentType: "video/mp4",
  retention: "video",
  storageKey: "meetings/m_a/orig.mp4",
  peaksStorageKey: "meetings/m_a/derived/asset_orig.peaks.v1.json",
  preparedAt: "2026-10-01T11:00:00.000Z",
})
const playback = asset({
  id: "asset_play",
  kind: "playback",
  derivedFromAssetId: "asset_orig",
  storageKey: "meetings/m_a/derived/play.m4a",
  createdAt: "2026-10-01T11:00:00.000Z",
})

function streamOf(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function useCtx(
  role: WorkspaceRole = "viewer",
  mediaAssets: MediaAsset[] = [original, playback],
  extra: Parameters<typeof testMeeting>[0][] = []
) {
  setRouteCtx(
    await createTestCtx({
      role,
      meetings: [
        testMeeting({ id: "m_a", mediaAssets }),
        testMeeting({ id: "m_private", visibility: "private", ownerUserId: "someone", mediaAssets }),
        testMeeting({ id: "m_other", workspaceId: "ws_b", mediaAssets }),
        ...extra.map((meeting) => testMeeting(meeting)),
      ],
    })
  )
}

function request(path = "", headers: Record<string, string> = {}, method = "GET") {
  return new Request(`http://localhost/api/meetings/m_a/media${path}`, { method, headers })
}

beforeEach(async () => {
  storage.getMeetingObjectRange.mockReset()
  // The fake object body is always 16 bytes; headers are what is under test.
  storage.getMeetingObjectRange.mockImplementation(async () => ({
    body: streamOf(new Uint8Array(16)),
  }))
  await useCtx()
})

describe("GET /api/meetings/:id/media", () => {
  it("answers bytes=0- with 206, exact headers and an 8 MiB cap", async () => {
    const response = await GET(request("", { range: "bytes=0-" }), routeParams({ id: "m_a" }))

    expect(response.status).toBe(206)
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "accept-ranges": "bytes",
      "content-type": "audio/mp4",
      "content-length": String(8 * 1024 * 1024),
      "content-range": `bytes 0-${8 * 1024 * 1024 - 1}/${SIZE}`,
      etag: '"a-asset_play-01234567"',
      "last-modified": new Date("2026-10-01T11:00:00.000Z").toUTCString(),
      "cache-control": "private, max-age=3600",
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
    })
    expect(storage.getMeetingObjectRange).toHaveBeenCalledWith("meetings/m_a/derived/play.m4a", {
      start: 0,
      end: 8 * 1024 * 1024 - 1,
      signal: expect.any(AbortSignal),
    })
    expect((await response.arrayBuffer()).byteLength).toBe(16)
  })

  it("serves suffix ranges", async () => {
    const response = await GET(request("", { range: "bytes=-100" }), routeParams({ id: "m_a" }))

    expect(response.status).toBe(206)
    expect(response.headers.get("content-range")).toBe(`bytes ${SIZE - 100}-${SIZE - 1}/${SIZE}`)
    expect(response.headers.get("content-length")).toBe("100")
  })

  it("streams the full object with 200 without a Range header", async () => {
    const response = await GET(request(), routeParams({ id: "m_a" }))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-length")).toBe(String(SIZE))
    expect(response.headers.get("content-range")).toBeNull()
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(storage.getMeetingObjectRange.mock.calls[0][1]).toEqual({
      signal: expect.any(AbortSignal),
    })
  })

  it("answers HEAD with headers only and never touches storage", async () => {
    const response = await HEAD(
      request("", { range: "bytes=0-99" }, "HEAD"),
      routeParams({ id: "m_a" })
    )

    expect(response.status).toBe(206)
    expect(response.headers.get("content-length")).toBe("100")
    expect(response.body).toBeNull()
    expect(storage.getMeetingObjectRange).not.toHaveBeenCalled()

    const full = await HEAD(request("", {}, "HEAD"), routeParams({ id: "m_a" }))

    expect(full.status).toBe(200)
    expect(full.headers.get("content-length")).toBe(String(SIZE))
  })

  it("answers an unsatisfiable range with 416 and bytes */size", async () => {
    const response = await GET(
      request("", { range: `bytes=${SIZE}-` }),
      routeParams({ id: "m_a" })
    )

    expect(response.status).toBe(416)
    expect(response.headers.get("content-range")).toBe(`bytes */${SIZE}`)
    expect(storage.getMeetingObjectRange).not.toHaveBeenCalled()
  })

  it("answers a matching If-None-Match with 304", async () => {
    const response = await GET(
      request("", { "if-none-match": '"a-asset_play-01234567"', range: "bytes=0-" }),
      routeParams({ id: "m_a" })
    )

    expect(response.status).toBe(304)
    expect(response.headers.get("etag")).toBe('"a-asset_play-01234567"')
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600")
    expect(storage.getMeetingObjectRange).not.toHaveBeenCalled()
  })

  it("serves the full 200 when If-Range does not match", async () => {
    const response = await GET(
      request("", { range: "bytes=100-199", "if-range": '"a-asset_play-stale"' }),
      routeParams({ id: "m_a" })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-range")).toBeNull()
    expect(response.headers.get("content-length")).toBe(String(SIZE))
  })

  it("selects the retained video for variant=video and rejects unknown variants", async () => {
    const video = await GET(request("?variant=video", { range: "bytes=0-9" }), routeParams({ id: "m_a" }))

    expect(video.status).toBe(206)
    expect(video.headers.get("content-type")).toBe("video/mp4")
    expect(storage.getMeetingObjectRange.mock.calls[0][0]).toBe("meetings/m_a/orig.mp4")

    const bad = await GET(request("?variant=hd"), routeParams({ id: "m_a" }))

    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: "invalid_variant" })
  })

  it("answers 404 no_media without a playable asset (and for video without retained video)", async () => {
    await useCtx("viewer", [])

    const none = await GET(request(), routeParams({ id: "m_a" }))

    expect(none.status).toBe(404)
    expect(await none.json()).toEqual({ error: "no_media" })

    await useCtx("viewer", [playback])
    const noVideo = await GET(request("?variant=video"), routeParams({ id: "m_a" }))

    expect(noVideo.status).toBe(404)
    expect(await noVideo.json()).toEqual({ error: "no_media" })
  })

  it("answers 404 for invisible and foreign meetings", async () => {
    for (const id of ["m_private", "m_other", "m_missing"]) {
      const response = await GET(request(), routeParams({ id }))

      expect(response.status, id).toBe(404)
      expect(await response.json()).toEqual({ error: "Meeting not found" })
    }
    expect(storage.getMeetingObjectRange).not.toHaveBeenCalled()
  })

  it("requires authentication (401 without a context)", async () => {
    setRouteCtx(undefined)

    expect((await GET(request(), routeParams({ id: "m_a" }))).status).toBe(401)
  })

  it("maps a missing object to 404 media_missing and other storage errors to 502", async () => {
    storage.getMeetingObjectRange.mockRejectedValueOnce(
      Object.assign(new Error("gone"), { name: "NoSuchKey" })
    )
    const missing = await GET(request("", { range: "bytes=0-" }), routeParams({ id: "m_a" }))

    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "media_missing" })

    storage.getMeetingObjectRange.mockRejectedValueOnce(
      Object.assign(new Error("bad range"), { name: "InvalidRange" })
    )
    const invalid = await GET(request("", { range: "bytes=0-" }), routeParams({ id: "m_a" }))

    expect(invalid.status).toBe(416)
    expect(invalid.headers.get("content-range")).toBe(`bytes */${SIZE}`)

    vi.spyOn(console, "error").mockImplementationOnce(() => undefined)
    storage.getMeetingObjectRange.mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
    const broken = await GET(request("", { range: "bytes=0-" }), routeParams({ id: "m_a" }))

    expect(broken.status).toBe(502)
    expect(await broken.json()).toEqual({ error: "media_unavailable" })
  })

  it("propagates a client abort to the storage request and its stream", async () => {
    let storageSignal: AbortSignal | undefined
    let cancelled = false

    storage.getMeetingObjectRange.mockImplementationOnce(
      async (_key: string, options: { signal: AbortSignal }) => {
        storageSignal = options.signal
        return {
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024))
            },
            cancel() {
              cancelled = true
            },
          }),
        }
      }
    )
    const client = new AbortController()
    const response = await GET(
      new Request("http://localhost/api/meetings/m_a/media", {
        headers: { range: "bytes=0-" },
        signal: client.signal,
      }),
      routeParams({ id: "m_a" })
    )
    const reader = response.body!.getReader()

    await reader.read()
    client.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(storageSignal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
  })

  it("aborts the storage request when the response stream is cancelled", async () => {
    let storageSignal: AbortSignal | undefined

    storage.getMeetingObjectRange.mockImplementationOnce(
      async (_key: string, options: { signal: AbortSignal }) => {
        storageSignal = options.signal
        return {
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(8))
            },
          }),
        }
      }
    )
    const response = await GET(request("", { range: "bytes=0-" }), routeParams({ id: "m_a" }))

    await response.body!.cancel()

    expect(storageSignal?.aborted).toBe(true)
  })

  it("honours MEETSUM_MEDIA_CACHE_MAX_AGE_SECONDS and MEETSUM_MEDIA_MAX_RANGE_BYTES", async () => {
    vi.stubEnv("MEETSUM_MEDIA_CACHE_MAX_AGE_SECONDS", "60")
    vi.stubEnv("MEETSUM_MEDIA_MAX_RANGE_BYTES", "1000")

    try {
      const response = await GET(request("", { range: "bytes=0-" }), routeParams({ id: "m_a" }))

      expect(response.headers.get("cache-control")).toBe("private, max-age=60")
      expect(response.headers.get("content-range")).toBe(`bytes 0-999/${SIZE}`)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("lets members and viewers play (meeting:read)", async () => {
    await useCtx("member")
    expect((await GET(request("", { range: "bytes=0-9" }), routeParams({ id: "m_a" }))).status).toBe(206)
  })
})

describe("GET /api/meetings/:id/media/peaks", () => {
  function peaksRequest(headers: Record<string, string> = {}) {
    return new Request("http://localhost/api/meetings/m_a/media/peaks", { headers })
  }

  it("streams the peaks JSON of the playback's original with a peaks ETag", async () => {
    storage.getMeetingObjectRange.mockResolvedValueOnce({
      body: streamOf(new TextEncoder().encode('{"v":1}')),
      contentLength: 7,
    })

    const response = await getPeaks(peaksRequest(), routeParams({ id: "m_a" }))
    const etag = `"p-asset_orig-${Date.parse("2026-10-01T11:00:00Z") / 1000}"`

    expect(response.status).toBe(200)
    expect(response.headers.get("etag")).toBe(etag)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600")
    expect(await response.text()).toBe('{"v":1}')
    expect(storage.getMeetingObjectRange.mock.calls[0][0]).toBe(
      "meetings/m_a/derived/asset_orig.peaks.v1.json"
    )

    const cached = await getPeaks(peaksRequest({ "if-none-match": etag }), routeParams({ id: "m_a" }))

    expect(cached.status).toBe(304)
    expect(storage.getMeetingObjectRange).toHaveBeenCalledTimes(1)
  })

  it("answers 404 no_peaks before preparation or when the object is gone", async () => {
    await useCtx("viewer", [asset({ id: "asset_raw" })])

    const unprepared = await getPeaks(peaksRequest(), routeParams({ id: "m_a" }))

    expect(unprepared.status).toBe(404)
    expect(await unprepared.json()).toEqual({ error: "no_peaks" })

    await useCtx()
    storage.getMeetingObjectRange.mockRejectedValueOnce(
      Object.assign(new Error("gone"), { name: "NoSuchKey" })
    )
    const gone = await getPeaks(peaksRequest(), routeParams({ id: "m_a" }))

    expect(gone.status).toBe(404)
    expect(await gone.json()).toEqual({ error: "no_peaks" })
  })

  it("answers 404 for invisible meetings", async () => {
    const response = await getPeaks(peaksRequest(), routeParams({ id: "m_private" }))

    expect(response.status).toBe(404)
  })
})
