import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { stat } from "node:fs/promises"
import { Readable, Transform, type TransformCallback } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as WebReadableStream } from "node:stream/web"

import { UploadTooLargeError } from "@/lib/capture/media-validation"

export type StoredObject = {
  bucket: string
  key: string
  contentType: string
  sizeBytes: number
}

let client: S3Client | undefined
const presignClients = new Map<string, S3Client>()
const ensuredBuckets = new Set<string>()

/**
 * Validates object-storage configuration up front so a misconfigured S3/MinIO
 * setup fails with a clear message at startup rather than as a cryptic error
 * mid-processing (after a meeting + job record already exist).
 */
export function assertObjectStorageConfigured(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!env.S3_ENDPOINT) {
    throw new Error(
      "Object storage is not configured: S3_ENDPOINT is required for meeting media."
    )
  }

  if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
    throw new Error(
      "Object storage credentials are incomplete: set both S3_ACCESS_KEY and S3_SECRET_KEY."
    )
  }
}

function getS3Client() {
  if (!client) {
    assertObjectStorageConfigured()
  }

  client ??= new S3Client({
    region: process.env.S3_REGION ?? "us-east-1",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials:
      process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY,
            secretAccessKey: process.env.S3_SECRET_KEY,
          }
        : undefined,
  })

  return client
}

export function getMeetingMediaBucket() {
  return process.env.S3_BUCKET ?? "meeting-media"
}

async function ensureBucket(bucket: string) {
  if (ensuredBuckets.has(bucket)) return

  const s3 = getS3Client()

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }))
  }

  ensuredBuckets.add(bucket)
}

function safeObjectFilename(filename: string) {
  return filename.replace(/[^\w. -]+/g, "_").slice(-180) || "upload"
}

/** Byte-counting + SHA-256 pass-through that aborts past `maxBytes`. */
export class CountingHashTransform extends Transform {
  readonly maxBytes: number
  bytes = 0
  private readonly hash = createHash("sha256")

  constructor(maxBytes: number) {
    super()
    this.maxBytes = maxBytes
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ) {
    this.bytes += chunk.length

    if (this.bytes > this.maxBytes) {
      callback(new UploadTooLargeError(this.maxBytes))
      return
    }

    this.hash.update(chunk)
    callback(null, chunk)
  }

  digest() {
    return this.hash.digest("hex")
  }
}

export type StreamBody =
  | Readable
  | AsyncIterable<Uint8Array>
  | WebReadableStream<Uint8Array>
  | ReadableStream<Uint8Array>

function toNodeReadable(body: StreamBody): Readable {
  if (body instanceof Readable) return body

  if (typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    return Readable.fromWeb(body as WebReadableStream<Uint8Array>)
  }

  return Readable.from(body as AsyncIterable<Uint8Array>)
}

export const MULTIPART_PART_SIZE = 8 * 1024 * 1024

/**
 * Streams a body into object storage with a multipart upload (8 MiB parts,
 * two in flight) while counting bytes and computing a SHA-256 checksum. The
 * whole file is never buffered in memory. Exceeding `maxBytes` aborts the
 * upload and throws {@link UploadTooLargeError}.
 */
export async function storeMeetingObjectStream(options: {
  keyPrefix: string
  filename: string
  contentType: string
  body: StreamBody
  maxBytes: number
}): Promise<StoredObject & { checksumSha256: string }> {
  const key = [
    options.keyPrefix.replace(/\/+$/, ""),
    `${Date.now()}-${crypto.randomUUID()}-${safeObjectFilename(options.filename)}`,
  ].join("/")
  const bucket = getMeetingMediaBucket()

  await ensureBucket(bucket)

  const source = toNodeReadable(options.body)
  const counter = new CountingHashTransform(options.maxBytes)
  let streamError: unknown

  const onError = (error: unknown) => {
    streamError ??= error
    counter.destroy(error instanceof Error ? error : new Error(String(error)))
  }

  source.once("error", onError)
  source.pipe(counter)

  const upload = new Upload({
    client: getS3Client(),
    queueSize: 2,
    partSize: MULTIPART_PART_SIZE,
    leavePartsOnError: false,
    params: {
      Bucket: bucket,
      Key: key,
      Body: counter,
      ContentType: options.contentType,
    },
  })

  counter.once("error", (error) => {
    streamError ??= error
    void upload.abort().catch(() => {})
  })

  try {
    await upload.done()
  } catch (error) {
    source.unpipe(counter)
    source.destroy()
    throw streamError ?? error
  }

  if (streamError) {
    await deleteMeetingObject(key).catch(() => {})
    throw streamError
  }

  return {
    bucket,
    key,
    contentType: options.contentType,
    sizeBytes: counter.bytes,
    checksumSha256: counter.digest(),
  }
}

/** Buffer variant kept for small imports (e.g. Google Drive artifacts). */
export async function storeMeetingObject(options: {
  meetingId: string
  filename: string
  contentType: string
  bytes: Buffer
}): Promise<StoredObject> {
  const safeFilename = options.filename.replace(/[^\w. -]+/g, "_")
  const key = [
    "meetings",
    options.meetingId,
    `${Date.now()}-${crypto.randomUUID()}-${safeFilename}`,
  ].join("/")
  const bucket = getMeetingMediaBucket()

  await ensureBucket(bucket)

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: options.bytes,
      ContentType: options.contentType,
    })
  )

  return {
    bucket,
    key,
    contentType: options.contentType,
    sizeBytes: options.bytes.length,
  }
}

export async function getMeetingObjectBytes(key: string): Promise<Buffer> {
  const result = await getS3Client().send(
    new GetObjectCommand({
      Bucket: getMeetingMediaBucket(),
      Key: key,
    })
  )

  if (!result.Body) {
    throw new Error(`Object body is empty: ${key}`)
  }

  const chunks: Buffer[] = []
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

export async function downloadMeetingObjectToFile(key: string, destination: string) {
  const result = await getS3Client().send(
    new GetObjectCommand({
      Bucket: getMeetingMediaBucket(),
      Key: key,
    })
  )

  if (!result.Body) {
    throw new Error(`Object body is empty: ${key}`)
  }

  await pipeline(
    result.Body as AsyncIterable<Uint8Array>,
    createWriteStream(destination)
  )
}

export async function deleteMeetingObject(key: string) {
  await getS3Client().send(
    new DeleteObjectCommand({
      Bucket: getMeetingMediaBucket(),
      Key: key,
    })
  )
}

export type DeleteMeetingObjectsResult = {
  deleted: string[]
  failed: Array<{ key: string; error: string }>
}

/**
 * Deletes many objects (M4: meeting delete, derived renditions, peaks).
 * Step 0 stub; Package A implements DeleteObjects batches of 1000 where a
 * missing key counts as deleted.
 */
export async function deleteMeetingObjects(
  keys: readonly string[]
): Promise<DeleteMeetingObjectsResult> {
  void keys
  throw new Error("deleteMeetingObjects: not implemented (M4)")
}

/**
 * Uploads a local file to an exact key (no timestamp/uuid decoration), e.g.
 * the transient `asr-handoff/<uuid>.ogg` objects handed to remote ASR.
 */
export async function putMeetingObjectFile(options: {
  key: string
  path: string
  contentType: string
}): Promise<StoredObject> {
  const bucket = getMeetingMediaBucket()
  const { size } = await stat(options.path)

  await ensureBucket(bucket)
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: options.key,
      Body: createReadStream(options.path),
      ContentLength: size,
      ContentType: options.contentType,
    })
  )

  return { bucket, key: options.key, contentType: options.contentType, sizeBytes: size }
}

function getPresignClient(endpoint: string, env: Record<string, string | undefined>) {
  const cacheKey = `${endpoint}|${env.S3_ACCESS_KEY ?? ""}|${env.S3_REGION ?? ""}`
  const existing = presignClients.get(cacheKey)

  if (existing) return existing

  const created = new S3Client({
    region: env.S3_REGION ?? "us-east-1",
    endpoint,
    forcePathStyle: true,
    credentials:
      env.S3_ACCESS_KEY && env.S3_SECRET_KEY
        ? { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY }
        : undefined,
  })

  presignClients.set(cacheKey, created)
  return created
}

/**
 * Time-limited GET URL for an object. MinIO is internal-only, so the URL is
 * signed against `publicEndpoint` (default `S3_PUBLIC_ENDPOINT`): SigV4
 * signs the host, so the public host must be used at signing time, not
 * substituted afterwards. Signing is local (no network call).
 */
export async function getMeetingObjectPresignedUrl(
  key: string,
  ttlSeconds: number,
  options: { publicEndpoint?: string; env?: Record<string, string | undefined> } = {}
): Promise<string> {
  const env = options.env ?? process.env
  const endpoint = (options.publicEndpoint ?? env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT ?? "").trim()

  if (!endpoint) {
    throw new Error("Presigned URLs need S3_PUBLIC_ENDPOINT (or S3_ENDPOINT)")
  }
  if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
    throw new Error("Presigned URLs need S3_ACCESS_KEY and S3_SECRET_KEY")
  }

  const ttl = Math.max(60, Math.min(7 * 24 * 3600, Math.round(ttlSeconds)))

  return getSignedUrl(
    getPresignClient(endpoint.replace(/\/+$/, ""), env),
    new GetObjectCommand({ Bucket: env.S3_BUCKET ?? "meeting-media", Key: key }),
    { expiresIn: ttl }
  )
}
