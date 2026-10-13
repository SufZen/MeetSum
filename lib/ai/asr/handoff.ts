import { readFile, stat } from "node:fs/promises"

import {
  deleteMeetingObject,
  getMeetingObjectPresignedUrl,
  putMeetingObjectFile,
} from "@/lib/storage/object-storage"

import { envNumber, envText, type AsrEnv } from "./config"
import { markMediaSpecific } from "./errors"
import { AsrError } from "./types"

/**
 * Hands transcoded audio to a remote ASR worker: either a presigned URL to
 * a transient `asr-handoff/<uuid>.ogg` object (needs `S3_PUBLIC_ENDPOINT`)
 * or an inline base64 blob for small files.
 */

export type HandoffMode = "auto" | "presigned" | "blob"

export type AsrHandoff =
  | { type: "url"; url: string; key: string; cleanup: () => Promise<void> }
  | { type: "blob"; data: string; cleanup: () => Promise<void> }

export type HandoffDeps = {
  env?: AsrEnv
  put?: typeof putMeetingObjectFile
  presign?: typeof getMeetingObjectPresignedUrl
  remove?: typeof deleteMeetingObject
  readFile?: (path: string) => Promise<Buffer>
  sizeOf?: (path: string) => Promise<number>
  uuid?: () => string
}

/** Raw bytes; base64 inflates by 4/3, so the RunPod request stays under ~10 MB. */
export const DEFAULT_RUNPOD_MAX_BLOB_BYTES = 7_000_000

export function getHandoffMode(env: AsrEnv): HandoffMode {
  const mode = envText(env, "MEETSUM_ASR_MEDIA_HANDOFF")?.toLowerCase()

  return mode === "presigned" || mode === "blob" ? mode : "auto"
}

/**
 * Uploads `file` under `asr-handoff/<uuid>.ogg` and returns a presigned URL
 * plus a cleanup that deletes the object (errors swallowed).
 */
export async function storeAsrHandoff(
  file: string,
  deps: HandoffDeps = {}
): Promise<{ key: string; url: string; cleanup: () => Promise<void> }> {
  const env = deps.env ?? process.env
  const key = `asr-handoff/${(deps.uuid ?? (() => crypto.randomUUID()))()}.ogg`
  const ttl = envNumber(env, "MEETSUM_ASR_HANDOFF_URL_TTL_SECONDS", 7200)
  const remove = deps.remove ?? deleteMeetingObject

  await (deps.put ?? putMeetingObjectFile)({ key, path: file, contentType: "audio/ogg" })

  let url: string

  try {
    url = await (deps.presign ?? getMeetingObjectPresignedUrl)(key, ttl, {
      publicEndpoint: envText(env, "S3_PUBLIC_ENDPOINT"),
      env,
    })
  } catch (error) {
    await remove(key).catch(() => undefined)
    throw error
  }

  return { key, url, cleanup: () => remove(key).catch(() => undefined) }
}

/**
 * Picks the handoff for `file` per `MEETSUM_ASR_MEDIA_HANDOFF`: `auto` →
 * presigned when `S3_PUBLIC_ENDPOINT` is set, else a base64 blob up to
 * `RUNPOD_MAX_BLOB_BYTES`, else a non-retryable config error.
 */
export async function prepareAsrHandoff(
  file: string,
  provider: string,
  deps: HandoffDeps = {}
): Promise<AsrHandoff> {
  const env = deps.env ?? process.env
  const mode = getHandoffMode(env)
  const publicEndpoint = envText(env, "S3_PUBLIC_ENDPOINT")
  const maxBlob = envNumber(env, "RUNPOD_MAX_BLOB_BYTES", DEFAULT_RUNPOD_MAX_BLOB_BYTES)

  if (mode === "presigned" || (mode === "auto" && publicEndpoint)) {
    if (!publicEndpoint) {
      throw new AsrError(
        "MEETSUM_ASR_MEDIA_HANDOFF=presigned needs S3_PUBLIC_ENDPOINT",
        "config",
        provider,
        false
      )
    }

    try {
      const stored = await storeAsrHandoff(file, deps)

      return { type: "url", ...stored }
    } catch (error) {
      throw new AsrError(
        `ASR media handoff upload failed: ${error instanceof Error ? error.message : String(error)}`,
        "server",
        provider,
        true
      )
    }
  }

  const size = await (deps.sizeOf ?? (async (path: string) => (await stat(path)).size))(file)

  if (size > maxBlob) {
    throw markMediaSpecific(new AsrError(
      `Audio is ${size} bytes, above RUNPOD_MAX_BLOB_BYTES (${maxBlob}); set S3_PUBLIC_ENDPOINT for presigned handoff`,
      "config",
      provider,
      false
    ))
  }

  const bytes = await (deps.readFile ?? ((path: string) => readFile(path)))(file)

  return { type: "blob", data: bytes.toString("base64"), cleanup: async () => undefined }
}
