"use client"

/**
 * Transcript for the selected meeting (M4 C4) from
 * `GET /api/meetings/[id]/transcript`, cached per meeting with its ETag so a
 * revisit or a version poll costs a 304. Segment mutations go through
 * `patchSegment` / `undoSegment` and are folded into the cached copy.
 */
import { useCallback, useEffect, useState } from "react"

import type {
  SegmentMutationResponse,
  TranscriptResponse,
  TranscriptSegmentWire,
} from "@/lib/meetings/transcript-wire"

type CacheEntry = { etag?: string; data: TranscriptResponse }

const cache = new Map<string, CacheEntry>()
const MAX_CACHED = 10

function remember(meetingId: string, entry: CacheEntry) {
  cache.delete(meetingId)
  cache.set(meetingId, entry)
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string)
}

export type TranscriptStatus = "idle" | "loading" | "ready" | "error"

export type SegmentPatchBody = {
  revision: number
  text?: string
  speakerId?: string
  newSpeakerName?: string
  scope?: "segment" | "turn"
}

export type MutationOutcome =
  | { ok: true; response: SegmentMutationResponse }
  | { ok: false; conflict: true; segment?: TranscriptSegmentWire }
  | { ok: false; conflict: false; status: number; error?: string }

async function mutation(url: string, method: "PATCH" | "POST", body: unknown): Promise<MutationOutcome> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>

    if (response.ok) return { ok: true, response: json as unknown as SegmentMutationResponse }
    if (response.status === 409 && json.error !== "nothing_to_undo") {
      return { ok: false, conflict: true, segment: json.segment as TranscriptSegmentWire | undefined }
    }

    return {
      ok: false,
      conflict: false,
      status: response.status,
      ...(typeof json.error === "string" ? { error: json.error } : {}),
    }
  } catch {
    return { ok: false, conflict: false, status: 0 }
  }
}

export function useMeetingTranscript(
  meetingId: string | undefined,
  {
    version,
  }: {
    /** `meeting.transcriptVersion`: a change triggers a conditional refetch. */
    version?: number
  } = {}
) {
  const [state, setState] = useState<{
    meetingId?: string
    status: TranscriptStatus
    data?: TranscriptResponse
  }>(() => {
    const cached = meetingId ? cache.get(meetingId) : undefined

    return cached ? { meetingId, status: "ready", data: cached.data } : { meetingId, status: "idle" }
  })
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!meetingId) return

    const controller = new AbortController()
    const cached = cache.get(meetingId)

    queueMicrotask(() => {
      if (controller.signal.aborted) return
      setState((current) =>
        current.meetingId === meetingId && current.data
          ? current
          : cached
            ? { meetingId, status: "ready", data: cached.data }
            : { meetingId, status: "loading" }
      )
    })

    fetch(`/api/meetings/${encodeURIComponent(meetingId)}/transcript`, {
      signal: controller.signal,
      headers: cached?.etag ? { "if-none-match": cached.etag } : {},
      cache: "no-store",
    })
      .then(async (response) => {
        if (response.status === 304 && cached) {
          setState({ meetingId, status: "ready", data: cached.data })
          return
        }
        if (!response.ok) throw new Error(String(response.status))

        const data = (await response.json()) as TranscriptResponse
        const etag = response.headers.get("etag") ?? undefined

        remember(meetingId, { ...(etag ? { etag } : {}), data })
        setState({ meetingId, status: "ready", data })
      })
      .catch(() => {
        if (controller.signal.aborted) return

        // No fallback: the detail route no longer carries the transcript, so
        // a failed fetch is a real error (stale data stays visible if any).
        setState((current) => ({ meetingId, status: current.data ? "ready" : "error", data: current.data }))
      })

    return () => controller.abort()
  }, [meetingId, reload, version])

  const data = state.meetingId === meetingId ? state.data : undefined

  /** Folds a server segment (and speakers/version) into the cached copy. */
  const applyMutation = useCallback(
    (response: Pick<SegmentMutationResponse, "segment" | "speakers" | "version">) => {
      if (!meetingId) return

      setState((current) => {
        if (current.meetingId !== meetingId || !current.data) return current

        const next: TranscriptResponse = {
          ...current.data,
          version: response.version,
          segments: current.data.segments.map((segment) =>
            segment.id === response.segment.id ? response.segment : segment
          ),
          ...(response.speakers ? { speakers: response.speakers } : {}),
        }

        // The ETag no longer matches; keep the data, drop the validator.
        remember(meetingId, { data: next })

        return { ...current, data: next }
      })
    },
    [meetingId]
  )

  /** Optimistic local text, rolled back by `applyMutation` or `refetch`. */
  const setSegmentText = useCallback(
    (segmentId: string, text: string) => {
      setState((current) => {
        if (current.meetingId !== meetingId || !current.data) return current

        return {
          ...current,
          data: {
            ...current.data,
            segments: current.data.segments.map((segment) =>
              segment.id === segmentId ? { ...segment, text } : segment
            ),
          },
        }
      })
    },
    [meetingId]
  )

  const refetch = useCallback(() => {
    if (meetingId) cache.delete(meetingId)
    setReload((value) => value + 1)
  }, [meetingId])

  const patchSegment = useCallback(
    (segmentId: string, body: SegmentPatchBody) =>
      mutation(
        `/api/meetings/${encodeURIComponent(meetingId ?? "")}/transcript/segments/${encodeURIComponent(segmentId)}`,
        "PATCH",
        body
      ),
    [meetingId]
  )

  const undoSegment = useCallback(
    (segmentId: string, revision: number) =>
      mutation(
        `/api/meetings/${encodeURIComponent(meetingId ?? "")}/transcript/segments/${encodeURIComponent(segmentId)}/undo`,
        "POST",
        { revision }
      ),
    [meetingId]
  )

  return {
    status: data ? "ready" : state.meetingId === meetingId ? state.status : "loading",
    data,
    applyMutation,
    setSegmentText,
    refetch,
    patchSegment,
    undoSegment,
  } as const
}

export type MeetingTranscriptHandle = ReturnType<typeof useMeetingTranscript>
