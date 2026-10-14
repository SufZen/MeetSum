import { NextResponse } from "next/server"

import type { MediaAsset } from "@/lib/meetings/repository"
import {
  evaluateConditionals,
  httpDate,
  mediaAssetEtag,
  peaksEtag,
} from "@/lib/media/conditional"
import {
  PLAYBACK_VARIANTS,
  selectPeaksSource,
  selectPlaybackAsset,
  type PlaybackVariant,
} from "@/lib/media/playback-select"
import { mediaMaxRangeBytes, parseRange } from "@/lib/media/range"
import type { ObjectRange } from "@/lib/storage/object-storage"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "media" })

/**
 * Media proxy (M4 Package A). The browser never talks to object storage:
 * routes stream S3 GetObject through Node with exact Range / conditional
 * semantics (206, 416, 304, HEAD) and abort propagation to S3.
 */

export type GetObjectRange = (
  key: string,
  options: { start?: number; end?: number; signal?: AbortSignal }
) => Promise<ObjectRange>

export type MediaProxyDeps = {
  getObjectRange?: GetObjectRange
  env?: Record<string, string | undefined>
}

export const DEFAULT_MEDIA_CACHE_MAX_AGE_SECONDS = 3600

type ProxiedAsset = Pick<
  MediaAsset,
  "id" | "storageKey" | "contentType" | "sizeBytes" | "checksumSha256" | "createdAt"
>

export function mediaCacheControl(env: Record<string, string | undefined> = process.env) {
  const parsed = Number(env.MEETSUM_MEDIA_CACHE_MAX_AGE_SECONDS)
  const maxAge =
    Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MEDIA_CACHE_MAX_AGE_SECONDS

  return `private, max-age=${maxAge}`
}

async function defaultGetObjectRange(
  key: string,
  options: { start?: number; end?: number; signal?: AbortSignal }
) {
  const { getMeetingObjectRange } = await import("@/lib/storage/object-storage")

  return getMeetingObjectRange(key, options)
}

function errorJson(error: string, status: number, headers?: HeadersInit) {
  return NextResponse.json({ error }, { status, headers })
}

function storageErrorKind(error: unknown): "missing" | "range" | "other" {
  const name = (error as { name?: string; Code?: string })?.name
  const code = (error as { Code?: string })?.Code
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode

  if (name === "NoSuchKey" || code === "NoSuchKey" || name === "NotFound" || status === 404) {
    return "missing"
  }
  if (name === "InvalidRange" || code === "InvalidRange" || status === 416) return "range"
  return "other"
}

function isAbort(error: unknown) {
  return (error as { name?: string })?.name === "AbortError"
}

/**
 * Re-exposes an S3 body so that cancelling the response (client gone) or
 * aborting the request aborts the S3 request and releases its socket.
 */
function linkBody(
  source: ReadableStream<Uint8Array>,
  controller: AbortController,
  requestSignal: AbortSignal | undefined
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let finished = false
  const onAbort = () => {
    if (finished) return
    finished = true
    controller.abort()
    void reader.cancel().catch(() => undefined)
  }
  const release = () => {
    finished = true
    requestSignal?.removeEventListener("abort", onAbort)
  }

  requestSignal?.addEventListener("abort", onAbort, { once: true })

  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const { done, value } = await reader.read()

        if (done) {
          release()
          stream.close()
          return
        }
        stream.enqueue(value)
      } catch (error) {
        release()
        stream.error(error)
      }
    },
    cancel(reason) {
      if (!finished) controller.abort(reason)
      release()
      return reader.cancel(reason).catch(() => undefined)
    },
  })
}

/**
 * Serves one asset for GET/HEAD: 304 (validators), 416 (`bytes *\/size`),
 * 206 (single range, capped), 200 (full). HEAD never touches storage.
 */
export async function createMediaResponse(options: {
  request: Request
  asset: ProxiedAsset
  deps?: MediaProxyDeps
}): Promise<Response> {
  const { request, asset } = options
  const env = options.deps?.env ?? process.env
  const getObjectRange = options.deps?.getObjectRange ?? defaultGetObjectRange
  const method = request.method.toUpperCase()
  const size = asset.sizeBytes
  const etag = mediaAssetEtag(asset)
  const lastModified = httpDate(asset.createdAt)
  const baseHeaders: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Content-Type": asset.contentType || "application/octet-stream",
    ETag: etag,
    "Last-Modified": lastModified.toUTCString(),
    "Cache-Control": mediaCacheControl(env),
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
  }
  const outcome = evaluateConditionals({
    method,
    headers: request.headers,
    etag,
    lastModified,
  })

  if (outcome === "not_modified") {
    const headers = { ...baseHeaders }

    delete headers["Content-Type"]
    delete headers["Content-Disposition"]
    return new Response(null, { status: 304, headers })
  }

  const range =
    outcome === "ignore_range"
      ? ({ type: "full" } as const)
      : parseRange(request.headers.get("range"), size, {
          maxChunkBytes: mediaMaxRangeBytes(env),
        })

  if (range.type === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
    })
  }

  const partial = range.type === "partial"
  const headers: Record<string, string> = {
    ...baseHeaders,
    "Content-Length": String(partial ? range.end - range.start + 1 : size),
    ...(partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
  }
  const status = partial ? 206 : 200

  if (method === "HEAD") return new Response(null, { status, headers })

  const controller = new AbortController()

  if (request.signal?.aborted) controller.abort()

  let object: ObjectRange

  try {
    object = await getObjectRange(asset.storageKey, {
      ...(partial ? { start: range.start, end: range.end } : {}),
      signal: controller.signal,
    })
  } catch (error) {
    if (isAbort(error) || controller.signal.aborted) {
      return new Response(null, { status: 499 })
    }

    const kind = storageErrorKind(error)

    if (kind === "missing") return errorJson("media_missing", 404)
    if (kind === "range") {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
      })
    }
    log.error({ errorName: (error as Error)?.name ?? error }, "Media proxy storage error")
    return errorJson("media_unavailable", 502)
  }

  return new Response(linkBody(object.body, controller, request.signal), {
    status,
    headers,
  })
}

export function parsePlaybackVariant(request: Request): PlaybackVariant | undefined {
  const value = new URL(request.url).searchParams.get("variant") ?? "audio"

  return (PLAYBACK_VARIANTS as readonly string[]).includes(value)
    ? (value as PlaybackVariant)
    : undefined
}

/** Media of a meeting the caller may play (already authorized). */
export async function serveMeetingMedia(options: {
  request: Request
  assets: readonly MediaAsset[]
  deps?: MediaProxyDeps
}): Promise<Response> {
  const variant = parsePlaybackVariant(options.request)

  if (!variant) return errorJson("invalid_variant", 400)

  const asset = selectPlaybackAsset(options.assets, variant)

  if (!asset) return errorJson("no_media", 404)

  return createMediaResponse({ request: options.request, asset, deps: options.deps })
}

/** Waveform peaks JSON of a meeting the caller may play (already authorized). */
export async function serveMeetingPeaks(options: {
  request: Request
  assets: readonly MediaAsset[]
  deps?: MediaProxyDeps
}): Promise<Response> {
  const { request } = options
  const env = options.deps?.env ?? process.env
  const source = selectPeaksSource(options.assets)

  if (!source?.peaksStorageKey) return errorJson("no_peaks", 404)

  const etag = peaksEtag(source)
  const lastModified = httpDate(source.preparedAt ?? source.createdAt)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ETag: etag,
    "Last-Modified": lastModified.toUTCString(),
    "Cache-Control": mediaCacheControl(env),
    "X-Content-Type-Options": "nosniff",
  }
  const outcome = evaluateConditionals({
    method: request.method,
    headers: request.headers,
    etag,
    lastModified,
  })

  if (outcome === "not_modified") {
    const { ["Content-Type"]: _contentType, ...rest } = headers

    void _contentType
    return new Response(null, { status: 304, headers: rest })
  }

  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: 200, headers })
  }

  const getObjectRange = options.deps?.getObjectRange ?? defaultGetObjectRange
  const controller = new AbortController()

  try {
    const object = await getObjectRange(source.peaksStorageKey, {
      signal: controller.signal,
    })

    return new Response(linkBody(object.body, controller, request.signal), {
      status: 200,
      headers: {
        ...headers,
        ...(object.contentLength !== undefined
          ? { "Content-Length": String(object.contentLength) }
          : {}),
      },
    })
  } catch (error) {
    if (storageErrorKind(error) === "missing") return errorJson("no_peaks", 404)
    if (isAbort(error)) return new Response(null, { status: 499 })
    log.error({ errorName: (error as Error)?.name ?? error }, "Peaks proxy storage error")
    return errorJson("media_unavailable", 502)
  }
}
