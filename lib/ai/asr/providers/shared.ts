import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { materializeMedia, probeDurationMs, transcodeForAsr, type ExecFileFn } from "../audio"
import type { AsrEnv } from "../config"
import type { HandoffDeps } from "../handoff"
import type { FetchFn } from "../http"
import type { AsrProviderId, AsrRequest } from "../types"

/** Injectable dependencies shared by every provider (tests inject all). */
export type AsrProviderDeps = {
  env?: AsrEnv
  fetch?: FetchFn
  execFile?: ExecFileFn
  download?: (key: string, destination: string) => Promise<void>
  readFile?: (path: string) => Promise<Buffer>
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  handoff?: HandoffDeps
}

export type PreparedAudio = {
  dir: string
  audioPath: string
  durationMs: number
  timings: Record<string, number>
  cleanup: () => Promise<void>
}

/**
 * Temp dir → media on disk → 16 kHz mono Opus → duration. The returned
 * cleanup removes the temp dir; on failure it is removed before rethrowing.
 */
export async function prepareAudio(
  req: AsrRequest,
  provider: AsrProviderId,
  deps: AsrProviderDeps
): Promise<PreparedAudio> {
  const now = deps.now ?? Date.now
  const env = deps.env ?? process.env
  const dir = await mkdtemp(path.join(tmpdir(), `meetsum-asr-${provider}-`))
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined)

  try {
    const started = now()
    const input = await materializeMedia(req.media, dir, { download: deps.download, provider })
    const downloaded = now()
    const audioPath = await transcodeForAsr(input, path.join(dir, "asr.ogg"), {
      execFile: deps.execFile,
      env,
      provider,
    })
    const transcoded = now()
    const durationMs = await probeDurationMs(audioPath, { execFile: deps.execFile, env, provider })

    return {
      dir,
      audioPath,
      durationMs,
      timings: { downloadMs: downloaded - started, transcodeMs: transcoded - downloaded },
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export function readAudio(deps: AsrProviderDeps, file: string): Promise<Buffer> {
  return (deps.readFile ?? ((value: string) => readFile(value)))(file)
}

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
