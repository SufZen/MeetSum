import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  cutAudioChunk,
  detectSilences,
  materializeMedia,
  parseSilenceDetect,
  planChunks,
  probeDurationMs,
  transcodeForAsr,
} from "@/lib/ai/asr/audio"
import { AsrError } from "@/lib/ai/asr/types"

import { fakeExecFile } from "./fixtures/asr/providers/fakes"

const SILENCE_STDERR = [
  "Input #0, ogg, from 'asr.ogg':",
  "[silencedetect @ 0x1] silence_start: 3.5",
  "[silencedetect @ 0x1] silence_end: 4.25 | silence_duration: 0.75",
  "[silencedetect @ 0x1] silence_start: 550",
  "[silencedetect @ 0x1] silence_end: 552 | silence_duration: 2",
  "[silencedetect @ 0x1] silence_start: 580.5",
  "[silencedetect @ 0x1] silence_end: 581 | silence_duration: 0.5",
  "size=N/A time=00:25:00.00 bitrate=N/A speed= 900x",
].join("\n")

let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs = []
})

describe("parseSilenceDetect", () => {
  it("parses ffmpeg silencedetect stderr into ms ranges", () => {
    expect(parseSilenceDetect(SILENCE_STDERR)).toEqual([
      { startMs: 3500, endMs: 4250 },
      { startMs: 550_000, endMs: 552_000 },
      { startMs: 580_500, endMs: 581_000 },
    ])
  })

  it("recovers a start from silence_duration and clamps negatives", () => {
    expect(parseSilenceDetect("silence_end: 10 | silence_duration: 2\nsilence_start: -0.01\nsilence_end: 0.5")).toEqual([
      { startMs: 8000, endMs: 10_000 },
      { startMs: 0, endMs: 500 },
    ])
  })
})

describe("planChunks", () => {
  it("keeps short audio in one chunk", () => {
    expect(planChunks(300_000, [])).toEqual([{ startMs: 0, endMs: 300_000 }])
  })

  it("splits a 25-minute recording into 3 chunks cutting inside the longest late silence", () => {
    const chunks = planChunks(1_500_000, parseSilenceDetect(SILENCE_STDERR), { maxMs: 600_000, searchMs: 60_000 })

    expect(chunks).toHaveLength(3)
    // Longest silence in [540 s, 600 s] is 550–552 s → cut at 551 s.
    expect(chunks[0]).toEqual({ startMs: 0, endMs: 551_000 })
    // No silence in [1091 s, 1151 s] → hard cut at the cap.
    expect(chunks[1]).toEqual({ startMs: 551_000, endMs: 1_151_000 })
    expect(chunks[2]).toEqual({ startMs: 1_151_000, endMs: 1_500_000 })
  })

  it("only considers the part of a silence inside the search window", () => {
    // Silence 500–590 s is long but mostly outside [580, 600]: clipped to 580–590 → cut 585 s.
    expect(planChunks(700_000, [{ startMs: 500_000, endMs: 590_000 }], { maxMs: 600_000, searchMs: 20_000 })[0]).toEqual({
      startMs: 0,
      endMs: 585_000,
    })
  })
})

describe("ffmpeg wrappers", () => {
  it("restricts every ffmpeg/ffprobe input to the file and pipe protocols", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "asr-audio-"))
    dirs.push(dir)
    const fake = fakeExecFile({ durationMs: 1000, silenceStderr: SILENCE_STDERR })

    await probeDurationMs("in.ogg", { execFile: fake.execFile, env: {} })
    await transcodeForAsr("in.mp4", path.join(dir, "out.ogg"), { execFile: fake.execFile, env: {} })
    await cutAudioChunk("asr.ogg", path.join(dir, "c.ogg"), { startMs: 0, endMs: 1000 }, { execFile: fake.execFile, env: {} })
    await detectSilences("asr.ogg", { execFile: fake.execFile, env: {} })

    expect(fake.calls).toHaveLength(4)
    for (const call of fake.calls) {
      const at = call.args.indexOf("-protocol_whitelist")
      const input = call.file === "ffprobe" ? call.args.length - 1 : call.args.indexOf("-i")

      expect(at, call.args.join(" ")).toBeGreaterThanOrEqual(0)
      expect(call.args[at + 1]).toBe("file,pipe")
      expect(at).toBeLessThan(input)
    }
  })

  it("passes the protocol whitelist in the Gemini and Drive ffmpeg callers too", async () => {
    const { readFile } = await import("node:fs/promises")

    for (const source of ["lib/ai/providers.ts", "lib/google/services.ts"]) {
      const text = await readFile(path.join(__dirname, "..", source), "utf8")
      const ffmpegCalls = text.split('"ffmpeg",').length - 1

      expect(ffmpegCalls, source).toBeGreaterThan(0)
      expect(text.split("...FFMPEG_INPUT_PROTOCOLS,").length - 1, source).toBe(ffmpegCalls)
    }
  })

  it("probes duration with ffprobe", async () => {
    const fake = fakeExecFile({ durationMs: 1_500_000 })

    await expect(probeDurationMs("in.ogg", { execFile: fake.execFile })).resolves.toBe(1_500_000)
    expect(fake.calls[0].file).toBe("ffprobe")
    expect(fake.calls[0].args).toContain("format=duration")
  })

  it("transcodes to 16 kHz mono Opus/OGG at the configured bitrate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "asr-audio-"))
    dirs.push(dir)
    const fake = fakeExecFile({ durationMs: 1000 })
    const output = path.join(dir, "out.ogg")

    await transcodeForAsr("in.mp4", output, { execFile: fake.execFile, env: { MEETSUM_ASR_AUDIO_BITRATE: "32k" } })

    const args = fake.calls[0].args

    expect(fake.calls[0].file).toBe("ffmpeg")
    expect(args.join(" ")).toContain("-vn -ac 1 -ar 16000 -c:a libopus -b:a 32k")
    expect(args.at(-1)).toBe(output)

    await transcodeForAsr("in.mp4", output, { execFile: fake.execFile, env: {} })
    expect(fake.calls[1].args.join(" ")).toContain("-b:a 24k")
  })

  it("cuts chunks with -ss/-t and runs silencedetect", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "asr-audio-"))
    dirs.push(dir)
    const fake = fakeExecFile({ durationMs: 1000, silenceStderr: SILENCE_STDERR })

    await cutAudioChunk("asr.ogg", path.join(dir, "c.ogg"), { startMs: 551_000, endMs: 1_151_000 }, { execFile: fake.execFile, env: {} })
    expect(fake.calls[0].args.join(" ")).toContain("-ss 551.000 -t 600.000 -protocol_whitelist file,pipe -i asr.ogg")

    await expect(detectSilences("asr.ogg", { execFile: fake.execFile, env: {} })).resolves.toHaveLength(3)
    expect(fake.calls[1].args).toContain("silencedetect=noise=-35dB:d=0.4")
  })

  it("maps undecodable media to bad_input and a missing binary to config", async () => {
    const undecodable = fakeExecFile({
      durationMs: 0,
      fail: Object.assign(new Error("Command failed"), { stderr: "in.bin: Invalid data found when processing input" }),
    })

    await expect(transcodeForAsr("in.bin", "out.ogg", { execFile: undecodable.execFile, env: {} })).rejects.toMatchObject({
      kind: "bad_input",
      retryable: false,
    })

    const missing = fakeExecFile({ durationMs: 0, fail: Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" }) })

    await expect(probeDurationMs("in.ogg", { execFile: missing.execFile })).rejects.toMatchObject({ kind: "config" })

    const noDuration = { execFile: async () => ({ stdout: "N/A\n", stderr: "" }) }

    await expect(probeDurationMs("in.ogg", noDuration)).rejects.toBeInstanceOf(AsrError)
  })
})

describe("materializeMedia", () => {
  it("returns file paths as-is and downloads objects into the temp dir", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "asr-audio-"))
    dirs.push(dir)
    const downloads: Array<[string, string]> = []

    await expect(materializeMedia({ kind: "file", path: "/x/a.wav", contentType: "audio/wav" }, dir)).resolves.toBe("/x/a.wav")

    const local = await materializeMedia(
      { kind: "object", storageKey: "meetings/m1/a.mp4", contentType: "video/mp4", filename: "My Meeting?.mp4" },
      dir,
      { download: async (key, destination) => void downloads.push([key, destination]) }
    )

    expect(downloads[0][0]).toBe("meetings/m1/a.mp4")
    expect(path.dirname(local)).toBe(dir)
    expect(path.basename(local)).toMatch(/^input-[0-9a-f-]{36}\.mp4$/)
    expect(downloads[0][1]).toBe(local)
  })

  it("ignores hostile or colliding user filenames", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "asr-audio-"))
    dirs.push(dir)
    const download = async () => undefined

    for (const filename of ["../../etc/passwd", "asr.ogg", "..", "a.weird ext!", "x.verylongextension"]) {
      const local = await materializeMedia({ kind: "object", storageKey: "k", contentType: "audio/ogg", filename }, dir, {
        download,
      })

      expect(path.dirname(local), filename).toBe(dir)
      expect(path.basename(local), filename).toMatch(/^input-[0-9a-f-]{36}(\.[a-z0-9]{1,8})?$/)
      expect(path.basename(local), filename).not.toBe("asr.ogg")
    }
  })

  it("maps a missing object to bad_input", async () => {
    await expect(
      materializeMedia({ kind: "object", storageKey: "gone", contentType: "audio/ogg" }, tmpdir(), {
        download: async () => {
          throw new Error("NoSuchKey: The specified key does not exist.")
        },
      })
    ).rejects.toMatchObject({ kind: "bad_input" })
  })
})
