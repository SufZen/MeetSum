import busboy from "busboy"
import { Readable } from "node:stream"
import type { ReadableStream as WebReadableStream } from "node:stream/web"

import {
  MEDIA_SIGNATURE_BYTES,
  UploadError,
  UploadTooLargeError,
  assertSupportedMedia,
} from "@/lib/capture/media-validation"
import { jsonError } from "@/lib/api/responses"
import {
  deleteMeetingObject,
  storeMeetingObjectStream,
} from "@/lib/storage/object-storage"

export type StoredUploadFile = {
  bucket: string
  storageKey: string
  filename: string
  contentType: string
  sizeBytes: number
  checksumSha256: string
}

export type ParsedMediaUpload = {
  /** Text fields, in arrival order (last value wins for repeated names). */
  fields: Record<string, string>
  /** The streamed + stored media file, when one was uploaded and stored. */
  file?: StoredUploadFile
  /** Present when a file part arrived but `resolveKeyPrefix` chose to skip it. */
  skippedFile?: { filename: string; contentType: string }
  /** Deletes the stored object (idempotent). Call when downstream work fails. */
  cleanup: () => Promise<void>
}

export type ParseMediaUploadOptions = {
  maxFileBytes: number
  maxFieldBytes: number
  /**
   * Called when the file part starts, with the fields received so far.
   * Return the object-key prefix to store under, or null to drain and skip
   * the file (e.g. an idempotent retry whose media is already stored).
   */
  resolveKeyPrefix: (
    fields: Record<string, string>
  ) => string | null | Promise<string | null>
}

const MAX_FIELDS = 8
/** Allowance for multipart boundaries and part headers. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024

async function* validateLeadingBytes(
  file: AsyncIterable<Buffer>,
  contentType: string,
  onContentType: (contentType: string) => void
): AsyncGenerator<Buffer> {
  let head = Buffer.alloc(0)
  let checked = false

  for await (const chunk of file) {
    if (checked) {
      yield chunk
      continue
    }

    head = Buffer.concat([head, chunk])

    if (head.length < MEDIA_SIGNATURE_BYTES) continue

    onContentType(assertSupportedMedia(contentType, head))
    checked = true
    yield head
  }

  if (!checked) {
    onContentType(assertSupportedMedia(contentType, head))
    if (head.length) yield head
  }
}

/**
 * Streams a multipart/form-data media upload straight into object storage
 * with busboy — the request body is never buffered in memory. Validates the
 * declared MIME type and the file signature on the first bytes, and enforces
 * size/field limits (413) and multipart-only bodies (415).
 */
export async function parseMediaUploadRequest(
  request: Request,
  options: ParseMediaUploadOptions
): Promise<ParsedMediaUpload> {
  const contentType = request.headers.get("content-type") ?? ""

  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new UploadError("Expected multipart/form-data upload", 415)
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "")
  const maxBodyBytes =
    options.maxFileBytes +
    options.maxFieldBytes * MAX_FIELDS +
    MULTIPART_OVERHEAD_BYTES

  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new UploadTooLargeError(options.maxFileBytes)
  }

  if (!request.body) {
    throw new UploadError("Upload body is empty", 400)
  }

  let parser: busboy.Busboy

  try {
    parser = busboy({
      headers: { "content-type": contentType },
      limits: {
        files: 1,
        fields: MAX_FIELDS,
        fieldSize: options.maxFieldBytes,
        fileSize: options.maxFileBytes,
        parts: MAX_FIELDS + 1,
      },
    })
  } catch (error) {
    throw new UploadError(
      error instanceof Error ? error.message : "Malformed multipart upload",
      400
    )
  }

  const source = Readable.fromWeb(request.body as WebReadableStream<Uint8Array>)
  const fields: Record<string, string> = {}
  let stored: StoredUploadFile | undefined
  let skippedFile: ParsedMediaUpload["skippedFile"]
  let filePromise: Promise<void> | undefined
  let activeFile: Readable | undefined
  let cleaned = false

  const cleanup = async () => {
    if (!stored || cleaned) return
    cleaned = true
    await deleteMeetingObject(stored.storageKey).catch(() => {})
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      const uploadError =
        error instanceof UploadError
          ? error
          : new UploadError(
              error instanceof Error ? error.message : "Upload failed",
              400
            )
      source.unpipe(parser)
      source.destroy()
      parser.removeAllListeners("file")
      activeFile?.destroy(uploadError)
      parser.destroy()
      reject(uploadError)
    }

    parser.on("field", (name, value, info) => {
      if (info.valueTruncated) {
        fail(new UploadError(`Field ${name} exceeds the ${options.maxFieldBytes} byte limit`, 413))
        return
      }

      fields[name] = value
    })

    parser.on("file", (name, stream, info) => {
      if (filePromise || name !== "file") {
        stream.resume()
        if (name !== "file") {
          fail(new UploadError(`Unexpected file field: ${name}`, 400))
        }
        return
      }

      activeFile = stream
      let tooLarge = false

      stream.once("limit", () => {
        tooLarge = true
        stream.destroy(new UploadTooLargeError(options.maxFileBytes))
      })

      const filename = info.filename || "upload"
      const declaredType = info.mimeType || "application/octet-stream"

      filePromise = (async () => {
        stream.pause()
        const keyPrefix = await options.resolveKeyPrefix({ ...fields })

        if (keyPrefix === null) {
          skippedFile = { filename, contentType: declaredType }
          stream.resume()
          return
        }

        let effectiveType = declaredType

        try {
          const result = await storeMeetingObjectStream({
            keyPrefix,
            filename,
            contentType: declaredType,
            body: validateLeadingBytes(stream, declaredType, (type) => {
              effectiveType = type
            }),
            maxBytes: options.maxFileBytes,
          })

          stored = {
            bucket: result.bucket,
            storageKey: result.key,
            filename,
            contentType: effectiveType,
            sizeBytes: result.sizeBytes,
            checksumSha256: result.checksumSha256,
          }
        } catch (error) {
          stream.resume()
          throw tooLarge ? new UploadTooLargeError(options.maxFileBytes) : error
        }
      })()

      filePromise.catch(fail)
    })

    parser.on("filesLimit", () =>
      fail(new UploadError("Only one file may be uploaded", 413))
    )
    parser.on("fieldsLimit", () =>
      fail(new UploadError(`At most ${MAX_FIELDS} fields are allowed`, 413))
    )
    parser.on("partsLimit", () =>
      fail(new UploadError("Too many multipart parts", 413))
    )
    parser.on("error", fail)
    source.on("error", fail)

    parser.on("close", () => {
      if (settled) return

      Promise.resolve(filePromise)
        .then(() => {
          if (settled) return
          settled = true
          resolve()
        })
        .catch(fail)
    })

    source.pipe(parser)
  }).catch(async (error) => {
    await Promise.resolve(filePromise).catch(() => {})
    await cleanup()
    throw error
  })

  return {
    fields,
    file: stored,
    skippedFile,
    cleanup,
  }
}

/** Parses a JSON-encoded multipart field, throwing a 400 UploadError if invalid. */
export function parseJsonField(
  fields: Record<string, string>,
  name: string
): unknown {
  const value = fields[name]

  if (typeof value !== "string" || !value.trim()) return undefined

  try {
    return JSON.parse(value)
  } catch {
    throw new UploadError(`${name} must be valid JSON`, 400)
  }
}

/** Maps upload/ingestion failures to JSON error responses. */
export function uploadErrorResponse(error: unknown, fallback: string) {
  if (error instanceof UploadError) {
    return jsonError(error.message, error.status)
  }

  console.error("[upload] ingestion failed", error)

  return jsonError(error instanceof Error ? error.message : fallback, 500)
}
