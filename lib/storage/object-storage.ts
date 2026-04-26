import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { createWriteStream } from "node:fs"
import { pipeline } from "node:stream/promises"

export type StoredObject = {
  bucket: string
  key: string
  contentType: string
  sizeBytes: number
}

let client: S3Client | undefined
const ensuredBuckets = new Set<string>()

function getS3Client() {
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
