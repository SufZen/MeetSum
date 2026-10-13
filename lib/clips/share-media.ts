/**
 * Serves a shared clip's audio through the M4 media proxy (Range,
 * conditional requests, HEAD) — never a presigned URL. Only the clip's own
 * object (`clips/<workspaceId>/<clipId>.m4a`) is ever read. Server-only.
 */
import { createHash } from "node:crypto"

import { NextResponse } from "next/server"

import { clipAudioReady } from "@/lib/clips/share-payload"
import { CLIP_CONTENT_TYPE, clipStorageKey } from "@/lib/clips/render"
import type { MeetingClip } from "@/lib/clips/types"
import { createMediaResponse, type MediaProxyDeps } from "@/lib/media/proxy"

export type ClipMediaDeps = MediaProxyDeps & {
  head?: (key: string) => Promise<{ sizeBytes: number; contentType?: string } | undefined>
}

async function defaultHead(key: string) {
  const { headMeetingObject } = await import("@/lib/storage/object-storage")

  return headMeetingObject(key)
}

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 })
}

/** Opaque, stable validator id (the clip id itself never leaves the server). */
function opaqueId(clip: Pick<MeetingClip, "id">) {
  return `clip-${createHash("sha256").update(clip.id).digest("hex").slice(0, 16)}`
}

export async function serveClipMedia(options: {
  request: Request
  clip: MeetingClip
  deps?: ClipMediaDeps
}): Promise<Response> {
  const { request, clip } = options

  if (!clipAudioReady(clip) || !clip.storageKey) return notFound()

  // Defence in depth: only the canonical clip key is served.
  if (clip.storageKey !== clipStorageKey(clip.workspaceId, clip.id)) return notFound()

  let head: { sizeBytes: number; contentType?: string } | undefined

  try {
    head = await (options.deps?.head ?? defaultHead)(clip.storageKey)
  } catch (error) {
    console.error("Clip media head failed", (error as Error)?.name ?? error)
    return NextResponse.json({ error: "media_unavailable" }, { status: 502 })
  }

  if (!head || head.sizeBytes <= 0) return notFound()

  return createMediaResponse({
    request,
    asset: {
      id: opaqueId(clip),
      storageKey: clip.storageKey,
      contentType: CLIP_CONTENT_TYPE,
      sizeBytes: head.sizeBytes,
      createdAt: clip.updatedAt,
    },
    deps: options.deps,
  })
}
