/**
 * Fake ASR for the e2e (docs/parity/m10.md, "Fake ASR and structured
 * replay"). An OpenAI-compatible Whisper stand-in served by the fake provider
 * server under `/asr` (so `LOCAL_TRANSCRIPTION_URL=http://127.0.0.1:4010/asr`):
 *
 *   GET  /asr/v1/models                 -> a one-model list
 *   POST /asr/v1/audio/transcriptions   -> the fixture for the uploaded file
 *
 * Fixtures live in `tests/fixtures/e2e/asr/<sha256>.json`, named by the
 * SHA-256 of the committed media file. Each is a `verbose_json` response plus
 * `x_meetsum_fixture: { id, tones }`. The uploaded file is matched by its
 * SHA-256 first; the app transcodes uploads to Opus before ASR, so on a miss
 * the audio is decoded (WAV directly, anything else through ffmpeg) and its
 * tone sequence compared (lib/testing/e2e-audio.ts). An unknown file gets
 * 422 so a wrong fixture fails loudly. Refused in production.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import type { FakeProviderResponse } from "@/lib/integrations/core/types"
import { detectTones, E2E_SAMPLE_RATE, toneMatch } from "@/lib/testing/e2e-audio"

export const FAKE_ASR_PREFIX = "/asr"
export const FAKE_ASR_MODEL = "fake-whisper-e2e"
export const DEFAULT_ASR_FIXTURE_DIR = path.join("tests", "fixtures", "e2e", "asr")
/** Share of matching tones needed to accept a transcoded file. */
const TONE_MATCH_THRESHOLD = 0.8

export type AsrFixture = {
  sha256: string
  id: string
  tones: number[]
  /** The verbose_json response (without `x_meetsum_fixture`). */
  response: Record<string, unknown>
}

export type FakeRawRequest = {
  method: string
  path: string
  headers: Record<string, string>
  body: Buffer
}

export type FakeAsrLogEntry = {
  method: string
  path: string
  provider: "asr"
  body?: { fileSha256?: string; fixtureId?: string; matchedBy?: "sha256" | "tones"; fields?: Record<string, string> }
}

export type FakeAsrOptions = {
  fixtureDir?: string
  /** Decodes any audio to 16 kHz mono s16le PCM (default: ffmpeg). */
  decode?: (audio: Buffer) => Promise<Buffer>
  log?: (entry: FakeAsrLogEntry) => void
}

function assertNotProduction() {
  if (process.env.NODE_ENV === "production") throw new Error("the fake ASR is refused in production")
}

export function sha256Hex(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function loadAsrFixtures(dir = DEFAULT_ASR_FIXTURE_DIR): AsrFixture[] {
  if (!existsSync(dir)) return []

  return readdirSync(dir)
    .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    .map((name) => {
      const raw = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>
      const meta = (raw.x_meetsum_fixture ?? {}) as { id?: unknown; tones?: unknown }
      const response = { ...raw }

      delete response.x_meetsum_fixture
      if (typeof meta.id !== "string" || !Array.isArray(meta.tones)) {
        throw new Error(`ASR fixture ${name} lacks x_meetsum_fixture.id/tones`)
      }
      return { sha256: name.slice(0, 64), id: meta.id, tones: meta.tones.map(Number), response }
    })
}

/** 16-bit PCM mono 16 kHz WAV data chunk, or undefined for anything else. */
export function wavPcm(bytes: Buffer): Buffer | undefined {
  if (bytes.byteLength < 44 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WAVE") {
    return undefined
  }

  let offset = 12
  let format: { channels: number; rate: number; bits: number } | undefined

  while (offset + 8 <= bytes.byteLength) {
    const id = bytes.toString("latin1", offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8

    if (id === "fmt ") {
      format = { channels: bytes.readUInt16LE(body + 2), rate: bytes.readUInt32LE(body + 4), bits: bytes.readUInt16LE(body + 14) }
    }
    if (id === "data") {
      if (!format || format.channels !== 1 || format.rate !== E2E_SAMPLE_RATE || format.bits !== 16) return undefined
      return bytes.subarray(body, Math.min(body + size, bytes.byteLength))
    }
    offset = body + size + (size % 2)
  }

  return undefined
}

/** ffmpeg: any audio on stdin -> 16 kHz mono s16le on stdout. */
export function ffmpegDecode(audio: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.FFMPEG_PATH || "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", String(E2E_SAMPLE_RATE), "pipe:1"],
      { stdio: ["pipe", "pipe", "ignore"] }
    )
    const chunks: Buffer[] = []

    child.on("error", reject)
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited with ${code}`))))
    child.stdin.on("error", () => undefined)
    child.stdin.end(audio)
  })
}

export type FixtureMatch = { fixture: AsrFixture; matchedBy: "sha256" | "tones" }

/** The fixture for an uploaded file: by SHA-256, else by tone sequence. */
export async function matchAsrFixture(
  audio: Buffer,
  fixtures: AsrFixture[],
  decode: (audio: Buffer) => Promise<Buffer> = ffmpegDecode
): Promise<FixtureMatch | undefined> {
  const hash = sha256Hex(audio)
  const exact = fixtures.find((fixture) => fixture.sha256 === hash)

  if (exact) return { fixture: exact, matchedBy: "sha256" }
  if (!fixtures.length) return undefined

  let pcm = wavPcm(audio)

  if (!pcm) {
    try {
      pcm = await decode(audio)
    } catch {
      return undefined
    }
  }

  const detected = detectTones(pcm)
  let best: { fixture: AsrFixture; score: number } | undefined

  for (const fixture of fixtures) {
    const score = toneMatch(fixture.tones, detected)

    if (!best || score > best.score) best = { fixture, score }
  }

  return best && best.score >= TONE_MATCH_THRESHOLD ? { fixture: best.fixture, matchedBy: "tones" } : undefined
}

/** Multipart form of a raw request (undici's parser). */
async function readForm(request: FakeRawRequest): Promise<FormData> {
  const contentType = request.headers["content-type"] ?? ""

  return new Request("http://fake.local/", {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Uint8Array(request.body),
  }).formData()
}

/**
 * The `/asr` route of the fake provider server. Fixtures are loaded on each
 * request, so `npm run e2e:fixtures` takes effect without a restart.
 */
export function createFakeAsr(options: FakeAsrOptions = {}) {
  assertNotProduction()

  const dir = options.fixtureDir ?? process.env.MEETSUM_FAKE_ASR_FIXTURE_DIR ?? DEFAULT_ASR_FIXTURE_DIR

  return async function handle(request: FakeRawRequest): Promise<FakeProviderResponse> {
    assertNotProduction()

    const route = request.path.slice(FAKE_ASR_PREFIX.length) || "/"

    if (request.method === "GET" && route === "/v1/models") {
      options.log?.({ method: request.method, path: request.path, provider: "asr" })
      return { body: { object: "list", data: [{ id: FAKE_ASR_MODEL, object: "model", owned_by: "meetsum-e2e" }] } }
    }

    if (request.method !== "POST" || route !== "/v1/audio/transcriptions") {
      return { status: 404, body: { error: { message: "fake_asr_route_not_found" } } }
    }

    let form: FormData

    try {
      form = await readForm(request)
    } catch {
      return { status: 400, body: { error: { message: "expected multipart/form-data" } } }
    }

    const file = form.get("file")

    if (!file || typeof file === "string") return { status: 400, body: { error: { message: "missing file" } } }

    const audio = Buffer.from(await file.arrayBuffer())
    const fields: Record<string, string> = {}

    for (const [key, value] of form.entries()) {
      // `prompt` and `hotwords` carry the workspace glossary: not logged.
      if (typeof value === "string" && key !== "prompt" && key !== "hotwords") fields[key] = value
    }

    const match = await matchAsrFixture(audio, loadAsrFixtures(dir), options.decode)
    const fileSha256 = sha256Hex(audio)

    options.log?.({
      method: request.method,
      path: request.path,
      provider: "asr",
      body: { fileSha256, fields, ...(match ? { fixtureId: match.fixture.id, matchedBy: match.matchedBy } : {}) },
    })

    if (!match) {
      return {
        status: 422,
        body: { error: { message: `no ASR fixture for this audio (sha256 ${fileSha256}); run npm run e2e:fixtures`, type: "unknown_fixture" } },
      }
    }

    return { body: match.fixture.response }
  }
}
