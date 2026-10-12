const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024

export const DEFAULT_MAX_UPLOAD_BYTES = 2 * GIB
export const DEFAULT_MAX_UPLOAD_FIELD_BYTES = 5 * MIB

/**
 * Upload/ingestion error that carries the HTTP status a route should return.
 */
export class UploadError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = "UploadError"
    this.status = status
  }
}

export class UploadTooLargeError extends UploadError {
  readonly maxBytes: number

  constructor(maxBytes: number, message?: string) {
    super(message ?? `Upload exceeds the ${maxBytes} byte limit`, 413)
    this.name = "UploadTooLargeError"
    this.maxBytes = maxBytes
  }
}

export type UploadLimits = {
  maxUploadBytes: number
  maxFieldBytes: number
  maxRecordingBytes: number
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value?.trim()) return fallback

  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export function getUploadLimits(
  env: NodeJS.ProcessEnv = process.env
): UploadLimits {
  const maxUploadBytes = positiveInteger(
    env.MEETSUM_MAX_UPLOAD_BYTES,
    DEFAULT_MAX_UPLOAD_BYTES
  )

  return {
    maxUploadBytes,
    maxFieldBytes: positiveInteger(
      env.MEETSUM_MAX_UPLOAD_FIELD_BYTES,
      DEFAULT_MAX_UPLOAD_FIELD_BYTES
    ),
    maxRecordingBytes: positiveInteger(
      env.MEETSUM_MAX_RECORDING_BYTES,
      maxUploadBytes
    ),
  }
}

const GENERIC_MEDIA_TYPES = new Set([
  "application/octet-stream",
  "application/ogg",
  "binary/octet-stream",
])

/** Media types accepted by the upload endpoints before signature sniffing. */
export function isAllowedMediaType(contentType: string | undefined): boolean {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase()

  if (!type) return false

  return (
    type.startsWith("audio/") ||
    type.startsWith("video/") ||
    GENERIC_MEDIA_TYPES.has(type)
  )
}

export function isGenericMediaType(contentType: string | undefined): boolean {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase()

  return !type || GENERIC_MEDIA_TYPES.has(type)
}

export type MediaSignature = {
  kind:
    | "iso-bmff"
    | "ebml"
    | "ogg"
    | "wave"
    | "mpeg"
    | "flac"
    | "adts"
    | "amr"
  contentType: string
}

/** Number of leading bytes needed by {@link sniffMediaSignature}. */
export const MEDIA_SIGNATURE_BYTES = 16

function ascii(bytes: Uint8Array, start: number, end: number) {
  return Buffer.from(bytes.subarray(start, end)).toString("latin1")
}

/**
 * Detects common audio/video container signatures from the first bytes of a
 * file. Returns undefined when the bytes don't look like supported media.
 */
export function sniffMediaSignature(
  bytes: Uint8Array
): MediaSignature | undefined {
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12)

    return {
      kind: "iso-bmff",
      contentType: brand.startsWith("M4A") ? "audio/mp4" : "video/mp4",
    }
  }

  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return { kind: "ebml", contentType: "video/webm" }
  }

  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "OggS") {
    return { kind: "ogg", contentType: "audio/ogg" }
  }

  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WAVE"
  ) {
    return { kind: "wave", contentType: "audio/wav" }
  }

  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "fLaC") {
    return { kind: "flac", contentType: "audio/flac" }
  }

  if (bytes.length >= 5 && ascii(bytes, 0, 5) === "#!AMR") {
    return { kind: "amr", contentType: "audio/amr" }
  }

  if (bytes.length >= 3 && ascii(bytes, 0, 3) === "ID3") {
    return { kind: "mpeg", contentType: "audio/mpeg" }
  }

  if (bytes.length >= 2 && bytes[0] === 0xff) {
    // ADTS: 12-bit sync word 0xFFF with layer bits == 00.
    if ((bytes[1] & 0xf6) === 0xf0) {
      return { kind: "adts", contentType: "audio/aac" }
    }

    // MPEG audio frame sync: 11 set bits, a valid version and a non-zero layer.
    if ((bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08 && (bytes[1] & 0x06) !== 0) {
      return { kind: "mpeg", contentType: "audio/mpeg" }
    }
  }

  return undefined
}

/**
 * Throws a 415 UploadError when the declared type or the leading bytes are
 * not a supported audio/video format. Returns the effective content type
 * (the sniffed one when the client sent a generic type).
 */
export function assertSupportedMedia(
  contentType: string | undefined,
  head: Uint8Array
): string {
  if (!isAllowedMediaType(contentType)) {
    throw new UploadError(
      `Unsupported media type: ${contentType || "unknown"}`,
      415
    )
  }

  const signature = sniffMediaSignature(head)

  if (!signature) {
    throw new UploadError("File content is not a supported audio/video format", 415)
  }

  return isGenericMediaType(contentType)
    ? signature.contentType
    : (contentType as string)
}

export function retentionForContentType(contentType: string): "audio" | "video" {
  return contentType.toLowerCase().startsWith("video/") ? "video" : "audio"
}
