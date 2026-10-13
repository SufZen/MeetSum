import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  /** Share fixture source for both lookups. */
  getShareByToken: vi.fn(),
  /** Full hydrating lookup (share page, verify route). */
  fullLookup: vi.fn(),
  /** Lightweight lookup the media routes must use. */
  mediaLookup: vi.fn(),
  getAppSettings: vi.fn(),
  getMeetingObjectRange: vi.fn(),
}))

vi.mock("@/lib/meetings/store", () => ({
  getShareLookup: () => ({
    getShareByToken: async (token: string) => {
      mocks.fullLookup(token)
      return mocks.getShareByToken(token)
    },
    getShareMediaByToken: async (token: string) => {
      mocks.mediaLookup(token)
      const result = await mocks.getShareByToken(token)

      return result
        ? {
            share: result.share,
            meeting: {
              id: result.meeting.id,
              workspaceId: result.meeting.workspaceId,
              visibility: result.meeting.visibility,
            },
            mediaAssets: result.meeting.mediaAssets ?? [],
          }
        : undefined
    },
  }),
}))
vi.mock("@/lib/settings/app-settings", () => ({ getAppSettings: mocks.getAppSettings }))
vi.mock("@/lib/storage/object-storage", () => ({
  getMeetingObjectRange: mocks.getMeetingObjectRange,
}))

import { GET as getPeaks } from "@/app/api/share/[token]/media/peaks/route"
import { GET, HEAD } from "@/app/api/share/[token]/media/route"
import { POST as verify } from "@/app/api/share/[token]/verify/route"
import { createApiKeyHash } from "@/lib/auth/api-keys"
import type { MediaAsset, MeetingRecord, MeetingShare } from "@/lib/meetings/repository"
import { createShareAccessCookie, SHARE_ACCESS_COOKIE } from "@/lib/sharing/share-access"
import {
  authorizeShareMediaRequest,
  getShareMediaCookiePath,
} from "@/lib/sharing/share-media-access"

const SECRET = "share-media-route-secret"
const TOKEN = "tok_share"
const asset: MediaAsset = {
  id: "asset_1",
  meetingId: "m_1",
  storageKey: "meetings/m_1/a.m4a",
  contentType: "audio/mp4",
  sizeBytes: 1000,
  retention: "audio",
  kind: "original",
  peaksStorageKey: "meetings/m_1/derived/asset_1.peaks.v1.json",
  preparedAt: "2026-10-01T11:00:00.000Z",
  createdAt: "2026-10-01T10:00:00.000Z",
}

function share(overrides: Partial<MeetingShare> = {}): MeetingShare {
  return {
    id: "share_1",
    meetingId: "m_1",
    token: TOKEN,
    visibility: "public",
    revoked: false,
    includedSections: ["summary", "transcript", "media"],
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  }
}

function meeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "m_1",
    title: "Shared",
    source: "upload",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-10-01T10:00:00.000Z",
    participants: [],
    workspaceId: "ws_1",
    visibility: "link",
    mediaAssets: [asset],
    ...overrides,
  }
}

function mediaRequest(headers: Record<string, string> = {}, method = "GET", path = "/media") {
  return new Request(`http://localhost/api/share/${TOKEN}${path}`, { method, headers })
}

const params = { params: Promise.resolve({ token: TOKEN }) }
let previousSecret: string | undefined

beforeAll(() => {
  previousSecret = process.env.MEETSUM_SESSION_SECRET
  process.env.MEETSUM_SESSION_SECRET = SECRET
  process.env.MEETSUM_RATE_LIMIT = "false"
})

afterAll(() => {
  if (previousSecret === undefined) delete process.env.MEETSUM_SESSION_SECRET
  else process.env.MEETSUM_SESSION_SECRET = previousSecret
  delete process.env.MEETSUM_RATE_LIMIT
})

beforeEach(() => {
  mocks.getShareByToken.mockReset().mockResolvedValue({ share: share(), meeting: meeting() })
  mocks.fullLookup.mockReset()
  mocks.mediaLookup.mockReset()
  mocks.getAppSettings.mockReset().mockResolvedValue({ publicSharingEnabled: true })
  mocks.getMeetingObjectRange.mockReset().mockResolvedValue({
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10))
        controller.close()
      },
    }),
  })
})

describe("GET /api/share/:token/media", () => {
  it("streams a share that includes the recording", async () => {
    const response = await GET(mediaRequest({ range: "bytes=0-9" }), params)

    expect(response.status).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 0-9/1000")
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600")
    expect(mocks.getShareByToken).toHaveBeenCalledWith(TOKEN)
    expect(mocks.getAppSettings).toHaveBeenCalledWith("ws_1")
  })

  it("uses the lightweight media lookup, never the hydrating share lookup", async () => {
    await GET(mediaRequest({ range: "bytes=0-9" }), params)
    await getPeaks(mediaRequest({}, "GET", "/media/peaks"), params).catch(() => undefined)

    expect(mocks.mediaLookup).toHaveBeenCalledWith(TOKEN)
    expect(mocks.fullLookup).not.toHaveBeenCalled()
  })

  it("answers HEAD without touching storage", async () => {
    const response = await HEAD(mediaRequest({}, "HEAD"), params)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-length")).toBe("1000")
    expect(mocks.getMeetingObjectRange).not.toHaveBeenCalled()
  })

  it.each([
    ["unknown/expired/revoked token", () => mocks.getShareByToken.mockResolvedValue(undefined)],
    ["revoked share", () =>
      mocks.getShareByToken.mockResolvedValue({ share: share({ revoked: true }), meeting: meeting() })],
    ["expired share", () =>
      mocks.getShareByToken.mockResolvedValue({
        share: share({ expiresAt: "2020-01-01T00:00:00.000Z" }),
        meeting: meeting(),
      })],
    ["meeting no longer link-visible", () =>
      mocks.getShareByToken.mockResolvedValue({
        share: share(),
        meeting: meeting({ visibility: "workspace" }),
      })],
    ["public sharing disabled", () =>
      mocks.getAppSettings.mockResolvedValue({ publicSharingEnabled: false })],
    ["media section not included", () =>
      mocks.getShareByToken.mockResolvedValue({
        share: share({ includedSections: ["summary", "transcript"] }),
        meeting: meeting(),
      })],
    ["password share without a cookie", () =>
      mocks.getShareByToken.mockResolvedValue({
        share: share({ passwordHash: createApiKeyHash("pw") }),
        meeting: meeting(),
      })],
    ["lookup failure", () => mocks.getShareByToken.mockRejectedValue(new Error("db down"))],
  ])("answers 404 for %s", async (_label, arrange) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    arrange()

    const media = await GET(mediaRequest({ range: "bytes=0-" }), params)
    const peaks = await getPeaks(mediaRequest({}, "GET", "/media/peaks"), params)

    expect(media.status).toBe(404)
    expect(peaks.status).toBe(404)
    expect(mocks.getMeetingObjectRange).not.toHaveBeenCalled()
  })

  it("plays a password share with a valid share-access cookie, not a forged one", async () => {
    const passwordHash = createApiKeyHash("pw")
    mocks.getShareByToken.mockResolvedValue({ share: share({ passwordHash }), meeting: meeting() })
    const cookie = createShareAccessCookie({ token: TOKEN, passwordHash, secret: SECRET })

    const ok = await GET(
      mediaRequest({ cookie: `${SHARE_ACCESS_COOKIE}=${cookie.value}`, range: "bytes=0-9" }),
      params
    )
    const forged = await GET(
      mediaRequest({ cookie: `${SHARE_ACCESS_COOKIE}=${Date.now() + 60_000}.forged` }),
      params
    )
    const otherToken = createShareAccessCookie({ token: "tok_other", passwordHash, secret: SECRET })
    const wrongToken = await GET(
      mediaRequest({ cookie: `${SHARE_ACCESS_COOKIE}=${otherToken.value}` }),
      params
    )

    expect(ok.status).toBe(206)
    expect(forged.status).toBe(404)
    expect(wrongToken.status).toBe(404)
  })

  it("serves peaks for an included recording", async () => {
    const response = await getPeaks(mediaRequest({}, "GET", "/media/peaks"), params)

    expect(response.status).toBe(200)
    expect(mocks.getMeetingObjectRange.mock.calls[0][0]).toBe(
      "meetings/m_1/derived/asset_1.peaks.v1.json"
    )
  })
})

describe("share media access cookie", () => {
  it("scopes a copy of the share-access cookie to the share's API path", async () => {
    const passwordHash = createApiKeyHash("correct-horse")
    mocks.getShareByToken.mockResolvedValue({ share: share({ passwordHash }), meeting: meeting() })

    const response = await verify(
      new Request(`http://localhost/api/share/${TOKEN}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct-horse" }),
      }),
      params
    )
    const cookies = response.headers.getSetCookie()

    expect(response.status).toBe(200)
    expect(cookies).toHaveLength(2)
    expect(cookies[0]).toContain(`Path=/share/${TOKEN}`)
    expect(cookies[1]).toContain(`Path=${getShareMediaCookiePath(TOKEN)}`)
    expect(cookies[1].toLowerCase()).toContain("httponly")
    expect(cookies[1]).not.toContain("correct-horse")

    const value = cookies[1].split(";")[0]
    const access = await authorizeShareMediaRequest(
      new Request("http://localhost", { headers: { cookie: value } }),
      TOKEN
    )

    expect(access?.meeting.id).toBe("m_1")
  })
})
