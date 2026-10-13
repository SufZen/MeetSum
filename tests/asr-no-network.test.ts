import { readdirSync } from "node:fs"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AsrEnv } from "@/lib/ai/asr/config"
import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr/default-glossary"
import { AsrError, type AsrProvider, type AsrRequest } from "@/lib/ai/asr/types"

/**
 * Every ASR provider module must be inert without credentials: with no
 * injected fetch and no env it reports `isConfigured() === false`, its
 * health check stays offline, and `transcribe` throws `AsrError("config")`
 * before touching the network (global fetch and undici both throw here).
 */

const networkCalls: string[] = []

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>()

  return {
    ...actual,
    fetch: (input: unknown) => {
      networkCalls.push(`undici:${String(input)}`)
      throw new Error("undici fetch must not be called without ASR credentials")
    },
  }
})

const PROVIDERS_DIR = path.join(__dirname, "..", "lib", "ai", "asr", "providers")

/** Credential / endpoint env vars any provider could fall back to. */
const CREDENTIAL_ENV = [
  "RUNPOD_API_KEY",
  "RUNPOD_ASR_ENDPOINT_ID",
  "SONIOX_API_KEY",
  "LOCAL_TRANSCRIPTION_URL",
  "LOCAL_TRANSCRIPTION_API_KEY",
  "MODAL_ASR_URL",
  "MODAL_ASR_TOKEN",
  "GOOGLE_GEMINI_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
]

const request: AsrRequest = {
  meetingId: "meet_no_network",
  workspaceId: "ws_no_network",
  language: "he",
  media: { kind: "object", storageKey: "meetings/no-network.webm", contentType: "audio/webm", filename: "a.webm" },
  glossary: DEFAULT_ASR_GLOSSARY,
  diarize: true,
}

type Factory = (deps?: { env?: AsrEnv }) => AsrProvider

async function loadFactories(): Promise<Array<{ module: string; name: string; create: Factory }>> {
  const modules = readdirSync(PROVIDERS_DIR).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
  const factories: Array<{ module: string; name: string; create: Factory }> = []

  for (const file of modules) {
    const mod = (await import(path.join(PROVIDERS_DIR, file))) as Record<string, unknown>

    for (const [name, value] of Object.entries(mod)) {
      if (/^create\w+Provider$/.test(name) && typeof value === "function") {
        factories.push({ module: file, name, create: value as Factory })
      }
    }
  }

  return factories
}

describe("ASR providers never reach the network without credentials", () => {
  beforeEach(() => {
    networkCalls.length = 0
    vi.stubGlobal("fetch", (input: unknown) => {
      networkCalls.push(`global:${String(input)}`)
      throw new Error("global fetch must not be called without ASR credentials")
    })
    for (const key of CREDENTIAL_ENV) vi.stubEnv(key, "")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("discovers a factory for every provider module", async () => {
    const factories = await loadFactories()
    const ids = factories.map(({ create }) => create({ env: {} }).id).sort()

    expect(ids).toEqual(["gemini-legacy", "local-whisper-chunked", "modal-worker", "runpod-ivrit", "soniox"].sort())

    const modulesWithFactory = new Set(factories.map((entry) => entry.module))
    const providerModules = readdirSync(PROVIDERS_DIR).filter(
      (file) => file.endsWith(".ts") && file !== "shared.ts"
    )
    expect([...modulesWithFactory].sort()).toEqual(providerModules.sort())
  })

  for (const envMode of ["empty env", "process.env without credentials"] as const) {
    describe(envMode, () => {
      const build = (create: Factory) => (envMode === "empty env" ? create({ env: {} }) : create())

      it("reports isConfigured false and an offline health check", async () => {
        for (const { name, create } of await loadFactories()) {
          const provider = build(create)

          expect(provider.isConfigured(), name).toBe(false)
          await expect(provider.healthCheck(), name).resolves.toMatchObject({ configured: false })
        }

        expect(networkCalls).toEqual([])
      })

      it("throws AsrError(config) from transcribe without network", async () => {
        for (const { name, create } of await loadFactories()) {
          const provider = build(create)
          const error = await provider.transcribe(request).then(
            () => undefined,
            (caught: unknown) => caught
          )

          expect(error, name).toBeInstanceOf(AsrError)
          expect((error as AsrError).kind, name).toBe("config")
          expect((error as AsrError).retryable, name).toBe(false)
        }

        expect(networkCalls).toEqual([])
      })
    })
  }
})
