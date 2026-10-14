/**
 * M10 A: the fake ASR (docs/parity/m10.md, "Fake ASR"). Hash routing, the
 * tone fallback for transcoded uploads, the 422 on unknown audio, the
 * verbose_json shape, the committed fixtures, and the production refusal.
 */
import { readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { parseWhisperChunk } from "@/lib/ai/asr/providers/local-whisper-chunked"
import { createFakeProviderServer, type FakeProviderServer } from "@/lib/integrations/testing/fake-server"
import { detectTones, toneMatch, toneSequence, toneWav } from "@/lib/testing/e2e-audio"
import { createFakeAsr, FAKE_ASR_PREFIX, loadAsrFixtures, matchAsrFixture, sha256Hex, wavPcm } from "@/lib/testing/fake-asr"
import { ASR_DIR, buildFixtures, FIXTURE_ID, MEDIA_FILE } from "@/scripts/e2e/make-audio-fixture"

const originalNodeEnv = process.env.NODE_ENV
let server: FakeProviderServer

function upload(file: Buffer, name = "asr.ogg"): FormData {
  const form = new FormData()

  form.set("file", new Blob([new Uint8Array(file)], { type: "audio/ogg" }), name)
  form.set("model", "fake")
  form.set("response_format", "verbose_json")
  form.set("prompt", "glossary terms are not logged")
  return form
}

beforeAll(async () => {
  server = await createFakeProviderServer({}, { rawRoutes: [{ prefix: FAKE_ASR_PREFIX, handle: createFakeAsr({ log: (entry) => server.record(entry) }) }] })
})

afterAll(async () => {
  await server.close()
})

afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv
})

describe("committed e2e fixtures", () => {
  it("the WAV and its ASR fixture are current (npm run e2e:fixtures)", () => {
    const { wav, sha256, asrJson } = buildFixtures()

    expect(readFileSync(MEDIA_FILE).equals(wav)).toBe(true)
    // Windows checkouts (core.autocrlf) may turn the JSON into CRLF.
    expect(readFileSync(path.join(ASR_DIR, `${sha256}.json`), "utf8").replace(/\r\n/g, "\n")).toBe(asrJson)
  })

  it("the WAV is 30 s of 16 kHz mono 16-bit PCM under 1 MB", () => {
    const wav = readFileSync(MEDIA_FILE)
    const pcm = wavPcm(wav)

    expect(wav.byteLength).toBeLessThan(1024 * 1024)
    expect(pcm?.byteLength).toBe(30 * 16_000 * 2)
  })

  it("the fixture is a verbose_json response with code-switched segments and word timestamps", () => {
    const [fixture] = loadAsrFixtures(ASR_DIR).filter((candidate) => candidate.id === FIXTURE_ID)
    const response = fixture!.response as { segments: Array<{ text: string; words: unknown[] }>; words: unknown[]; duration: number }

    expect(response.duration).toBe(30)
    expect(response.segments.length).toBeGreaterThanOrEqual(4)
    expect(response.segments.some((segment) => /\p{Script=Hebrew}/u.test(segment.text))).toBe(true)
    expect(response.segments.some((segment) => /^[\s\x20-\x7E]+$/.test(segment.text))).toBe(true)
    expect(response.segments.every((segment) => segment.words.length > 0)).toBe(true)

    // The local-whisper provider parses it into timed words.
    const parsed = parseWhisperChunk(response as never, { startMs: 0, endMs: 30_000 })

    expect(parsed.synthetic).toBe(false)
    expect(parsed.words.length).toBe(response.words.length)
  })
})

describe("tone fingerprint", () => {
  it("reads the tone sequence back from PCM", () => {
    const tones = toneSequence(5, 10)
    const pcm = wavPcm(toneWav(tones))!

    expect(toneMatch(tones, detectTones(pcm))).toBe(1)
  })

  it("matches a decoded (transcoded) file by tones when the hash misses", async () => {
    const fixtures = loadAsrFixtures(ASR_DIR)
    const pcm = wavPcm(readFileSync(MEDIA_FILE))!
    // Stand-in for ffmpeg: "decoding" the opaque upload yields slightly noisy PCM.
    const noisy = Buffer.from(pcm)

    for (let offset = 0; offset < noisy.byteLength; offset += 2) {
      noisy.writeInt16LE(Math.max(-32_768, Math.min(32_767, noisy.readInt16LE(offset) + ((offset * 7919) % 401) - 200)), offset)
    }

    const match = await matchAsrFixture(Buffer.from("opaque-opus-bytes"), fixtures, async () => noisy)

    expect(match?.fixture.id).toBe(FIXTURE_ID)
    expect(match?.matchedBy).toBe("tones")
  })

  it("does not match a different tone sequence", async () => {
    const other = toneWav(toneSequence(11))

    expect(await matchAsrFixture(other, loadAsrFixtures(ASR_DIR))).toBeUndefined()
  })
})

describe("the /asr route of the fake provider server", () => {
  it("lists a model", async () => {
    const response = await fetch(`${server.url}/asr/v1/models`)

    expect(response.status).toBe(200)
    expect((await response.json()).data[0].id).toBeTruthy()
  })

  it("answers the committed WAV by its SHA-256 and logs no glossary text", async () => {
    const wav = readFileSync(MEDIA_FILE)
    const response = await fetch(`${server.url}/asr/v1/audio/transcriptions`, { method: "POST", body: upload(wav, "he-en-30s.wav") })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.segments.length).toBeGreaterThan(0)
    expect(body.x_meetsum_fixture).toBeUndefined()

    const logged = server.requests("asr").at(-1)!

    expect(logged.body).toMatchObject({ fileSha256: sha256Hex(wav), fixtureId: FIXTURE_ID, matchedBy: "sha256" })
    expect(JSON.stringify(logged)).not.toContain("glossary terms")
  })

  it("returns 422 for unknown audio", async () => {
    const response = await fetch(`${server.url}/asr/v1/audio/transcriptions`, {
      method: "POST",
      body: upload(toneWav(toneSequence(17, 5)), "x.wav"),
    })

    expect(response.status).toBe(422)
    expect((await response.json()).error.type).toBe("unknown_fixture")
  })

  it("returns 400 without a file", async () => {
    const form = new FormData()

    form.set("model", "fake")
    expect((await fetch(`${server.url}/asr/v1/audio/transcriptions`, { method: "POST", body: form })).status).toBe(400)
  })

  it("rejects malformed fixtures", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fake-asr-"))

    try {
      await writeFile(path.join(dir, `${"a".repeat(64)}.json`), JSON.stringify({ text: "x" }))
      expect(() => loadAsrFixtures(dir)).toThrow(/x_meetsum_fixture/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("production", () => {
  it("is refused when NODE_ENV=production", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production"
    expect(() => createFakeAsr()).toThrow(/production/)
  })
})
