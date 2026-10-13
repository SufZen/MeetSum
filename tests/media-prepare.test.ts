import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ExecFileFn } from "@/lib/ai/asr/audio"
import type { MediaAsset, MeetingRecord } from "@/lib/meetings/repository"
import { mediaBinaries, parseFfprobeDuration } from "@/lib/media/ffmpeg"
import { parsePeaksFile } from "@/lib/media/peaks"
import {
  derivedKeyPrefix,
  MediaPreparePermanentError,
  peaksStorageKeyFor,
  playbackDecision,
  prepareMediaAsset,
  type PrepareRepository,
  type PrepareStorage,
} from "@/lib/media/prepare"

const NOW = new Date("2026-10-13T12:00:00.000Z")

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: "asset_1",
    meetingId: "m_1",
    storageKey: "meetings/m_1/1700-uuid-rec.wav",
    filename: "../../evil name;rm -rf.wav",
    contentType: "audio/wav",
    sizeBytes: 5_000_000,
    retention: "audio",
    kind: "original",
    createdAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  }
}

function meetingWith(assets: MediaAsset[]): MeetingRecord {
  return {
    id: "m_1",
    title: "Weekly",
    source: "upload",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-10-01T10:00:00.000Z",
    participants: [],
    workspaceId: "ws_1",
    mediaAssets: assets,
  }
}

/** 1 s of s16le PCM at 8 kHz with one loud sample. */
function pcmBytes() {
  const buffer = Buffer.alloc(8000 * 2)

  buffer.writeInt16LE(-32768, 1000)
  return buffer
}

type Call = { file: string; args: string[] }

let tmpRoot: string
let calls: Call[]
let exec: ExecFileFn
let storage: PrepareStorage & {
  putJson: ReturnType<typeof vi.fn>
  storeFile: ReturnType<typeof vi.fn>
  deleteObjects: ReturnType<typeof vi.fn>
  deleteAssetRows: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
}
let repo: PrepareRepository & {
  getMeeting: ReturnType<typeof vi.fn>
  createMediaAsset: ReturnType<typeof vi.fn>
  updateMediaAssetPreparation: ReturnType<typeof vi.fn>
  setMeetingDurationMs: ReturnType<typeof vi.fn>
}

function useAssets(assets: MediaAsset[]) {
  repo.getMeeting.mockResolvedValue(meetingWith(assets))
}

function run(options: Partial<Parameters<typeof prepareMediaAsset>[0]> = {}) {
  return prepareMediaAsset({
    meetingId: "m_1",
    assetId: "asset_1",
    repo,
    storage,
    exec,
    env: { FFMPEG_PATH: "/opt/ffmpeg", FFPROBE_PATH: "/opt/ffprobe" },
    tmpRoot,
    now: () => NOW,
    ...options,
  })
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "meetsum-prepare-test-"))
  calls = []
  exec = vi.fn(async (file: string, args: string[]) => {
    calls.push({ file, args })
    if (file.endsWith("ffprobe")) return { stdout: "61.5\n", stderr: "" }

    const output = args[args.length - 1]

    await writeFile(output, args.includes("s16le") ? pcmBytes() : Buffer.from("m4a-bytes"))
    return { stdout: "", stderr: "" }
  }) as unknown as ExecFileFn
  storage = {
    download: vi.fn(async (_key: string, destination: string) => {
      await writeFile(destination, "source-bytes")
    }),
    putJson: vi.fn(async () => undefined),
    storeFile: vi.fn(async (options: { keyPrefix: string; filename: string }) => ({
      bucket: "meeting-media",
      key: `${options.keyPrefix}/1700-uuid-${options.filename}`,
      contentType: "audio/mp4",
      sizeBytes: 9,
      checksumSha256: "feedbeef",
    })),
    deleteObjects: vi.fn(async (keys: readonly string[]) => ({ deleted: [...keys], failed: [] })),
    deleteAssetRows: vi.fn(async () => undefined),
  }
  repo = {
    getMeeting: vi.fn(),
    createMediaAsset: vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      id: "asset_play_new",
      createdAt: NOW.toISOString(),
    })),
    updateMediaAssetPreparation: vi.fn(async () => asset()),
    setMeetingDurationMs: vi.fn(async () => undefined),
  } as typeof repo
  useAssets([asset()])
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe("prepareMediaAsset", () => {
  it("probes, writes peaks, transcodes a playback rendition and records the preparation", async () => {
    const result = await run()

    expect(result).toEqual({
      status: "prepared",
      assetId: "asset_1",
      durationMs: 61_500,
      peaksStorageKey: "meetings/m_1/derived/asset_1.peaks.v1.json",
      playback: "transcoded",
      playbackAssetId: "asset_play_new",
    })

    // Binaries from FFMPEG_PATH/FFPROBE_PATH, protocol whitelist before input.
    expect(calls.map((call) => call.file)).toEqual(["/opt/ffprobe", "/opt/ffmpeg", "/opt/ffmpeg"])
    for (const call of calls) {
      const whitelist = call.args.indexOf("-protocol_whitelist")
      const input = call.file.endsWith("ffprobe") ? call.args.length - 1 : call.args.indexOf("-i")

      expect(whitelist).toBeGreaterThanOrEqual(0)
      expect(call.args[whitelist + 1]).toBe("file,pipe")
      expect(whitelist).toBeLessThan(input)
      // Never the user's filename: generated names inside the temp dir.
      expect(call.args.join(" ")).not.toContain("evil")
    }
    const sourcePath = storage.download.mock.calls[0][1] as string
    expect(path.basename(sourcePath)).toBe("source.wav")
    expect(path.dirname(path.dirname(sourcePath))).toBe(tmpRoot)
    expect(calls[1].args).toEqual(
      expect.arrayContaining(["-ac", "1", "-ar", "8000", "-f", "s16le"])
    )
    expect(calls[2].args).toEqual(
      expect.arrayContaining(["-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart"])
    )

    const [peaksKey, peaks] = storage.putJson.mock.calls[0]
    expect(peaksKey).toBe("meetings/m_1/derived/asset_1.peaks.v1.json")
    expect(parsePeaksFile(peaks)).toMatchObject({
      v: 1,
      durationMs: 61_500,
      sampleRate: 8000,
      samplesPerPeak: 400,
      max: 255,
    })
    expect((peaks as { peaks: number[] }).peaks).toHaveLength(20)

    expect(storage.storeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPrefix: "meetings/m_1/derived",
        filename: "asset_1.playback.m4a",
        contentType: "audio/mp4",
      })
    )
    expect(repo.createMediaAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: "m_1",
        kind: "playback",
        derivedFromAssetId: "asset_1",
        retention: "audio",
        contentType: "audio/mp4",
        durationMs: 61_500,
        sizeBytes: 9,
        checksumSha256: "feedbeef",
      })
    )
    expect(repo.updateMediaAssetPreparation).toHaveBeenCalledWith("asset_1", {
      durationMs: 61_500,
      peaksStorageKey: "meetings/m_1/derived/asset_1.peaks.v1.json",
      preparedAt: NOW.toISOString(),
      prepareError: null,
    })
    expect(repo.setMeetingDurationMs).toHaveBeenCalledWith("m_1", 61_500, "media")
    expect(await readdir(tmpRoot)).toEqual([])
  })

  it("passes small mp3 originals through (auto) without a rendition", async () => {
    useAssets([asset({ contentType: "audio/mpeg", filename: "talk.mp3" })])

    const result = await run()

    expect(result.playback).toBe("passthrough")
    expect(calls.map((call) => call.file)).toEqual(["/opt/ffprobe", "/opt/ffmpeg"])
    expect(repo.createMediaAsset).not.toHaveBeenCalled()
    expect(repo.updateMediaAssetPreparation).toHaveBeenCalled()
  })

  it("replaces an older playback rendition", async () => {
    const old = asset({
      id: "asset_play_old",
      kind: "playback",
      derivedFromAssetId: "asset_1",
      storageKey: "meetings/m_1/derived/old.m4a",
      contentType: "audio/mp4",
    })
    useAssets([asset(), old])

    await run({ force: true })

    expect(storage.deleteAssetRows).toHaveBeenCalledWith("ws_1", ["asset_play_old"])
    expect(storage.deleteObjects).toHaveBeenCalledWith(["meetings/m_1/derived/old.m4a"])
  })

  it("is idempotent: a prepared asset with its rendition is skipped unless forced", async () => {
    const prepared = asset({
      preparedAt: "2026-10-02T00:00:00.000Z",
      peaksStorageKey: "meetings/m_1/derived/asset_1.peaks.v1.json",
      durationMs: 61_500,
    })
    const playback = asset({
      id: "asset_play",
      kind: "playback",
      derivedFromAssetId: "asset_1",
      contentType: "audio/mp4",
    })
    useAssets([prepared, playback])

    await expect(run()).resolves.toMatchObject({
      status: "skipped",
      playbackAssetId: "asset_play",
      durationMs: 61_500,
    })
    expect(storage.download).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()

    await expect(run({ force: true })).resolves.toMatchObject({ status: "prepared" })
    expect(storage.download).toHaveBeenCalledTimes(1)
  })

  it("re-runs a prepared asset whose rendition is missing", async () => {
    useAssets([
      asset({ preparedAt: "2026-10-02T00:00:00.000Z", peaksStorageKey: "k.json" }),
    ])

    await expect(run()).resolves.toMatchObject({ status: "prepared", playback: "transcoded" })
  })

  it("falls back to the PCM sample count when ffprobe fails", async () => {
    const base = exec
    exec = vi.fn(async (file: string, args: string[], options?: { timeout?: number }) => {
      if (file.endsWith("ffprobe")) throw new Error("ffprobe: invalid data")
      return base(file, args, options)
    }) as unknown as ExecFileFn

    await expect(run()).resolves.toMatchObject({ durationMs: 1000 })
    expect(repo.setMeetingDurationMs).toHaveBeenCalledWith("m_1", 1000, "media")
  })

  it("passes MEETSUM_MEDIA_PREPARE_TIMEOUT_MS to every binary call", async () => {
    await run({
      env: { MEETSUM_MEDIA_PREPARE_TIMEOUT_MS: "1234", MEETSUM_PLAYBACK_AUDIO_BITRATE: "48k" },
    })

    for (const [, , options] of vi.mocked(exec).mock.calls) {
      expect(options).toMatchObject({ timeout: 1234 })
    }
    expect(calls[2].args).toEqual(expect.arrayContaining(["-b:a", "48k"]))
    expect(calls[0].file).toBe("ffprobe")
  })

  it("cleans the temp dir and records nothing when ffmpeg fails", async () => {
    exec = vi.fn(async (file: string) => {
      if (file.endsWith("ffprobe")) return { stdout: "10\n", stderr: "" }
      throw new Error("Invalid data found when processing input")
    }) as unknown as ExecFileFn

    await expect(run()).rejects.toThrow(/Invalid data/)
    expect(repo.updateMediaAssetPreparation).not.toHaveBeenCalled()
    expect(repo.setMeetingDurationMs).not.toHaveBeenCalled()
    expect(await readdir(tmpRoot)).toEqual([])
  })

  it("cleans the temp dir when the download fails", async () => {
    storage.download.mockRejectedValueOnce(new Error("NoSuchKey"))

    await expect(run()).rejects.toThrow("NoSuchKey")
    expect(await readdir(tmpRoot)).toEqual([])
  })

  it("fails permanently for a missing meeting or a non-original asset", async () => {
    repo.getMeeting.mockResolvedValueOnce(undefined)
    await expect(run()).rejects.toBeInstanceOf(MediaPreparePermanentError)

    useAssets([asset({ kind: "playback" })])
    await expect(run()).rejects.toBeInstanceOf(MediaPreparePermanentError)

    useAssets([])
    await expect(run()).rejects.toBeInstanceOf(MediaPreparePermanentError)
    expect(storage.download).not.toHaveBeenCalled()
  })
})

describe("media preparation helpers", () => {
  it("applies MEETSUM_PLAYBACK_TRANSCODE", () => {
    const mp3 = { contentType: "audio/mpeg", sizeBytes: 10 }
    const big = { contentType: "audio/mp4", sizeBytes: 200 * 1024 * 1024 }
    const wav = { contentType: "audio/wav", sizeBytes: 10 }

    expect(playbackDecision(mp3, {})).toBe("passthrough")
    expect(playbackDecision(big, {})).toBe("transcoded")
    expect(playbackDecision(wav, {})).toBe("transcoded")
    expect(playbackDecision(mp3, { MEETSUM_PLAYBACK_TRANSCODE: "always" })).toBe("transcoded")
    expect(playbackDecision(wav, { MEETSUM_PLAYBACK_TRANSCODE: "never" })).toBe("none")
    expect(
      playbackDecision(mp3, { MEETSUM_PLAYBACK_PASSTHROUGH_MAX_BYTES: "5" })
    ).toBe("transcoded")
  })

  it("derives object keys next to the original", () => {
    expect(derivedKeyPrefix("meetings/m_1/a.wav")).toBe("meetings/m_1/derived")
    expect(derivedKeyPrefix("a.wav")).toBe("derived")
    expect(peaksStorageKeyFor({ id: "x", storageKey: "w/m/a.wav" })).toBe("w/m/derived/x.peaks.v1.json")
  })

  it("parses ffprobe durations", () => {
    expect(parseFfprobeDuration("61.5\n")).toBe(61_500)
    expect(parseFfprobeDuration("N/A")).toBeUndefined()
    expect(parseFfprobeDuration("0")).toBeUndefined()
    expect(parseFfprobeDuration("")).toBeUndefined()
  })

  it("defaults the binaries to ffmpeg/ffprobe on PATH", () => {
    expect(mediaBinaries({})).toEqual({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" })
  })
})
