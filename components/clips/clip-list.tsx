"use client"

/**
 * Clips of a meeting (M5 C5): title, range, duration and render state,
 * play (the meeting player plays the clip's range), copy share link and
 * delete. Refetches on focus and every 30 s while any clip is rendering.
 */
import { useCallback, useEffect, useState } from "react"
import { LinkIcon, PlayIcon, ScissorsIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import {
  COLLAB_REFRESH_MS,
  CollabRequestError,
  collabApi,
  useCollabStrings,
} from "@/components/comments/collab-client"
import { CommentAnchor } from "@/components/comments/comment-anchor"
import { Button } from "@/components/ui/button"
import { formatClipClock } from "@/lib/clips/range"
import type { ClipWire } from "@/lib/clips/types"
import { usePlayer } from "@/lib/player/contract"

export type ClipListProps = {
  meetingId: string
  /** Bump to refetch (e.g. after the transcript created a clip). */
  refreshKey?: number
}

type ListState =
  | { status: "loading" }
  | { status: "ready"; clips: ClipWire[] }
  | { status: "error" }

/** Clip lists refetch when any clip is created on the page. */
export const CLIPS_CHANGED_EVENT = "meetsum:clips-changed"

export function notifyClipsChanged(meetingId: string) {
  window.dispatchEvent(new CustomEvent(CLIPS_CHANGED_EVENT, { detail: { meetingId } }))
}

export function ClipList({ meetingId, refreshKey }: ClipListProps) {
  const { t } = useCollabStrings()
  const player = usePlayer()
  const [state, setState] = useState<ListState>({ status: "loading" })

  const load = useCallback(
    () =>
      collabApi.listClips(meetingId).then(
        ({ clips }) => setState({ status: "ready", clips }),
        () => setState((current) => (current.status === "ready" ? current : { status: "error" }))
      ),
    [meetingId]
  )

  useEffect(() => {
    let cancelled = false

    collabApi.listClips(meetingId).then(
      ({ clips }) => {
        if (!cancelled) setState({ status: "ready", clips })
      },
      () => {
        if (!cancelled) setState((current) => (current.status === "ready" ? current : { status: "error" }))
      }
    )
    return () => {
      cancelled = true
    }
  }, [meetingId, refreshKey])

  useEffect(() => {
    const onFocus = () => void load()
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<{ meetingId?: string }>).detail?.meetingId === meetingId) void load()
    }
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load()
    }, COLLAB_REFRESH_MS)

    window.addEventListener("focus", onFocus)
    window.addEventListener(CLIPS_CHANGED_EVENT, onChanged)
    return () => {
      clearInterval(timer)
      window.removeEventListener("focus", onFocus)
      window.removeEventListener(CLIPS_CHANGED_EVENT, onChanged)
    }
  }, [load, meetingId])

  const copyLink = async (clip: ClipWire) => {
    try {
      const { url } = await collabApi.shareClip(clip.id)

      await navigator.clipboard.writeText(url)
      toast.success(t.clipsLinkCopied)
    } catch (error) {
      toast.error(
        error instanceof CollabRequestError && error.code === "meeting_private"
          ? t.clipsSharePrivate
          : t.clipsShareFailed
      )
    }
  }

  const remove = async (clip: ClipWire) => {
    try {
      await collabApi.deleteClip(clip.id)
      toast.success(t.clipsDeleted)
      await load()
    } catch {
      toast.error(t.clipsCreateFailed)
    }
  }

  if (state.status === "loading") {
    return <div aria-busy className="h-24 animate-pulse rounded-lg bg-surface-2" />
  }

  if (state.status === "error") {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-line p-4 text-sm text-fg-3">
        {t.clipsLoadFailed}
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          {t.clipsRetry}
        </Button>
      </div>
    )
  }

  if (!state.clips.length) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-line p-4 text-sm text-fg-3">
        <ScissorsIcon aria-hidden className="size-4 shrink-0" />
        {t.clipsEmpty}
      </div>
    )
  }

  return (
    <section aria-label={t.clipsTitle} className="grid gap-2">
      <ul className="grid gap-2">
        {state.clips.map((clip) => (
          <li
            key={clip.id}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-line bg-surface p-3"
          >
            <Button
              size="icon-sm"
              variant="secondary"
              aria-label={`${t.clipsPlay}: ${clip.title}`}
              title={t.clipsPlay}
              disabled={!player.available}
              onClick={() => player.playRange(clip.startMs, clip.endMs)}
            >
              <PlayIcon />
            </Button>
            <div className="min-w-0">
              <p dir="auto" className="truncate text-sm font-medium">
                {clip.title}
              </p>
              <p className="flex flex-wrap gap-x-2 text-xs text-fg-3">
                <span className="font-mono tabular-nums [direction:ltr] [unicode-bidi:isolate]">
                  {formatClipClock(clip.startMs)}–{formatClipClock(clip.endMs)} ·{" "}
                  {formatClipClock(clip.endMs - clip.startMs)}
                </span>
                {clip.renderStatus === "pending" ? <span role="status">{t.clipsRendering}</span> : null}
                {clip.renderStatus === "failed" ? (
                  <span className="text-danger-text">{t.clipsRenderFailed}</span>
                ) : null}
              </p>
            </div>
            <div className="flex items-center gap-0.5">
              <CommentAnchor meetingId={meetingId} targetType="clip" targetId={clip.id} />
              {clip.canManage ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t.clipsCopyLink}
                    title={t.clipsCopyLink}
                    onClick={() => void copyLink(clip)}
                  >
                    <LinkIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t.clipsDelete}
                    title={t.clipsDelete}
                    onClick={() => void remove(clip)}
                  >
                    <Trash2Icon />
                  </Button>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
