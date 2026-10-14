import { readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"

import { signVexaWebhook } from "../lib/bot/webhook-verify"

/**
 * M7 B9 — local bot smoke test.
 *
 *   npm run bot:simulate -- [--url http://localhost:3000] [--vexa-meeting-id 4242]
 *     [--platform google_meet] [--native-id abc-defg-hij] [--delay 500]
 *     [--fake-vexa] [--port 18056]
 *
 * Posts the signed fixture webhooks requested → joining → awaiting_admission
 * → active → completed to /api/integrations/vexa/webhook, signed with
 * VEXA_WEBHOOK_SECRET (read from the environment, never printed). Event ids
 * get a per-run suffix so reruns are not deduplicated.
 *
 * With --fake-vexa it first starts a tiny local Vexa stand-in (POST /bots,
 * GET /meetings/:id, the recording raw stream, transcripts, status, DELETE)
 * serving a generated WAV recording, so with VEXA_API_URL pointed at it the
 * worker runs finalize end-to-end into media.ingest. Keep it running (Ctrl-C
 * to stop) while the worker finalizes.
 *
 * M10 (the core e2e job): `--serve-only` starts only the fake Vexa (no
 * webhooks; tests/e2e/m10-bot.spec.ts posts them with `postSimulatedWebhook`)
 * and `--wav <file>` serves that recording instead of the silent one, e.g.
 * tests/fixtures/e2e/media/he-en-30s.wav, which the fake ASR recognizes.
 */

export type Args = {
  url: string
  vexaMeetingId: string
  platform: string
  nativeId: string
  delayMs: number
  fakeVexa: boolean
  port: number
  /** Only serve the fake Vexa; post no webhooks (the e2e posts its own). */
  serveOnly: boolean
  /** Recording the fake Vexa serves (default: a 2 s silent WAV). */
  wav?: string
}

const STEPS = [
  "status-requested",
  "status-joining",
  "status-awaiting_admission",
  "status-active",
  "completed",
] as const

function parseArgs(argv: string[]): Args {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`)

    return index >= 0 ? argv[index + 1] : undefined
  }

  return {
    url: (value("url") ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
    vexaMeetingId: value("vexa-meeting-id") ?? "4242",
    platform: value("platform") ?? "google_meet",
    nativeId: value("native-id") ?? "abc-defg-hij",
    delayMs: Number(value("delay") ?? 500),
    fakeVexa: argv.includes("--fake-vexa") || argv.includes("--serve-only"),
    port: Number(value("port") ?? 18056),
    serveOnly: argv.includes("--serve-only"),
    wav: value("wav"),
  }
}

/** A short silent 16 kHz mono WAV (the recording fixture). */
export function silentWav(seconds = 2, sampleRate = 16_000): Buffer {
  const dataBytes = seconds * sampleRate * 2
  const header = Buffer.alloc(44)

  header.write("RIFF", 0, "latin1")
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write("WAVE", 8, "latin1")
  header.write("fmt ", 12, "latin1")
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36, "latin1")
  header.writeUInt32LE(dataBytes, 40)

  return Buffer.concat([header, Buffer.alloc(dataBytes)])
}

/** Loads a fixture and rewrites ids for this run. */
export function simulationBody(step: string, args: Args, runId: string): string {
  const file = path.join(process.cwd(), "tests", "fixtures", "vexa", "webhooks", `${step}.json`)
  const body = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  const data = (body.data ?? {}) as Record<string, unknown>
  const meeting = (data.meeting ?? {}) as Record<string, unknown>

  delete body._synthetic
  delete data.webhook_secret
  body.event_id = `${String(body.event_id ?? step)}_${runId}`
  meeting.id = args.vexaMeetingId
  meeting.platform = args.platform
  meeting.native_meeting_id = args.nativeId

  return JSON.stringify(body)
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}

function startFakeVexa(args: Args) {
  // The e2e serves tests/fixtures/e2e/media/he-en-30s.wav so the fake ASR knows it.
  const wav = args.wav ? readFileSync(args.wav) : silentWav()
  const stats = { botsRequested: 0, recordingFetches: 0 }
  const mediaFile = { id: "m1", type: "audio", format: "wav", content_type: "audio/wav", size_bytes: wav.length }
  const meeting = {
    id: args.vexaMeetingId,
    platform: args.platform,
    native_meeting_id: args.nativeId,
    status: "completed",
    start_time: new Date(Date.now() - 60_000).toISOString(),
    end_time: new Date().toISOString(),
    recordings: [
      {
        id: "rec1",
        status: "completed",
        started_at: new Date(Date.now() - 60_000).toISOString(),
        // The recordings shape is undocumented: serve both spellings.
        media_files: [mediaFile],
        media: [mediaFile],
      },
    ],
    data: { service_provenance: { bot_outcome: "served" } },
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${args.port}`)
    const route = `${request.method} ${url.pathname}`

    console.log(`[fake-vexa] ${route}`)

    // e2e inspection: how many bots were requested and how often the recording was fetched.
    if (route === "GET /__fake/stats") return json(response, 200, stats)
    if (route === "POST /bots") {
      stats.botsRequested += 1
      return json(response, 201, { id: args.vexaMeetingId, status: "requested" })
    }
    if (route === "GET /recordings/rec1/media/m1/raw") stats.recordingFetches += 1
    if (request.method === "DELETE") return json(response, 200, { status: "stopping", meeting_id: args.vexaMeetingId })
    if (route === "GET /bots/status") return json(response, 200, { running_bots: [], running: [], count: 0 })
    if (route === `GET /meetings/${args.vexaMeetingId}`) return json(response, 200, meeting)
    if (route === "GET /recordings/rec1/master") return json(response, 200, { media_id: "m1" })
    if (route === "GET /recordings/rec1/media/m1/raw") {
      response.writeHead(200, { "content-type": "audio/wav", "content-length": String(wav.length) })
      return response.end(wav)
    }
    if (url.pathname.startsWith("/transcripts/")) {
      return json(response, 200, { id: args.vexaMeetingId, segments: [] })
    }
    if (url.pathname === "/" || url.pathname === "/health") return json(response, 200, { status: "ok", version: "0.12.28-fake" })

    return json(response, 404, { detail: "not found" })
  })

  server.listen(args.port, "127.0.0.1", () => {
    console.log(`[fake-vexa] listening on http://127.0.0.1:${args.port} (set VEXA_API_URL to this)`)
  })

  return server
}

export const SIMULATION_STEPS = STEPS

/** Default simulation arguments (the e2e overrides ids per run). */
export function simulationArgs(overrides: Partial<Args> = {}): Args {
  return { ...parseArgs([]), ...overrides }
}

/**
 * Posts one Vexa webhook body to the app, signed with `secret` (a wrong
 * secret produces a bad signature on purpose in the e2e).
 */
export async function postSimulatedWebhook(baseUrl: string, secret: string, body: string): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000))

  return fetch(`${baseUrl.replace(/\/+$/, "")}/api/integrations/vexa/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-timestamp": timestamp,
      "x-webhook-signature": signVexaWebhook(secret, timestamp, body),
    },
    body,
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const server = args.fakeVexa ? startFakeVexa(args) : undefined

  if (args.serveOnly) {
    console.log("[fake-vexa] serve-only: posting no webhooks; Ctrl-C to stop.")
    return
  }

  const secret = process.env.VEXA_WEBHOOK_SECRET

  if (!secret) {
    console.error("VEXA_WEBHOOK_SECRET must be set (the same value the app uses).")
    process.exit(1)
  }

  const runId = Date.now().toString(36)

  for (const step of STEPS) {
    const response = await postSimulatedWebhook(args.url, secret, simulationBody(step, args, runId))

    console.log(`${step.padEnd(28)} -> ${response.status} ${await response.text()}`)
    await new Promise((resolve) => setTimeout(resolve, args.delayMs))
  }

  if (server) {
    console.log("[fake-vexa] still serving the recording for finalize; Ctrl-C to stop.")
  }
}

if (process.argv[1] && /bot-simulate/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
