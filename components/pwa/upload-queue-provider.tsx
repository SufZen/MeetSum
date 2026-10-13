"use client"

/**
 * Offline recording queue context (docs/parity/m9.md D5; owner: Package D).
 * Mounted by the shell with the signed-in user's id and the session's
 * workspace id (from the server): only that partition is listed, recovered
 * or uploaded, so another user's or workspace's recordings never appear. On mount it recovers
 * chunks left by a closed tab and flushes; it flushes again on `online`,
 * when the tab becomes visible, on the service worker's `flush-uploads`
 * message, at the next back-off deadline, and on a manual retry. The queue
 * code (IndexedDB) loads after hydration, outside the initial bundle.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import { activeCaptureIds } from "@/components/bot/use-browser-recorder"
import { useOptionalI18n } from "@/components/i18n-provider"
import type { QueueSnapshot, UploadQueue } from "@/lib/client/upload-queue/queue"

export type UploadQueueContextValue = {
  snapshot: QueueSnapshot | null
  online: boolean
  /** Uploads every item now (ignores back-off and the sign-in pause). */
  retry: () => void
  /** Downloads a stored recording (permanent failures). */
  saveToDevice: (captureId: string) => Promise<void>
  discard: (captureId: string) => Promise<void>
  /** Deletes every queued recording of the user, in every workspace (logout after confirming). */
  clearAll: () => Promise<void>
  /** Uploads the item now (after stop), outside the back-off schedule. */
  flushNow: () => void
}

const UploadQueueContext = createContext<UploadQueueContextValue | null>(null)

export function useUploadQueue(): UploadQueueContextValue | null {
  return useContext(UploadQueueContext)
}

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback)
  window.addEventListener("offline", callback)

  return () => {
    window.removeEventListener("online", callback)
    window.removeEventListener("offline", callback)
  }
}

/** navigator.onLine; true during SSR so the banner never flashes. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true
  )
}

export function UploadQueueProvider({
  userId,
  workspaceId,
  onUploaded,
  children,
}: {
  userId?: string | null
  workspaceId?: string | null
  /** Called when items leave the queue after a successful upload. */
  onUploaded?: () => void
  children: ReactNode
}) {
  const i18n = useOptionalI18n()
  const online = useOnline()
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null)
  const queueRef = useRef<UploadQueue | null>(null)
  const uploadedRef = useRef(onUploaded)
  const recoveredTitle = i18n?.t("pwaRecoveredRecording") ?? "Recovered recording"
  const titleRef = useRef(recoveredTitle)

  useEffect(() => {
    uploadedRef.current = onUploaded
    titleRef.current = recoveredTitle
  }, [onUploaded, recoveredTitle])

  const flush = useCallback((force = false) => {
    void queueRef.current?.flush({ force }).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!userId || !workspaceId) return

    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let previous = -1
    let timer: number | undefined

    const schedule = (value: QueueSnapshot) => {
      window.clearTimeout(timer)

      const due = value.items
        .filter((item) => item.status === "pending" && item.nextAttemptAt !== null)
        .map((item) => item.nextAttemptAt as number)
        .sort((a, b) => a - b)[0]

      if (due !== undefined) timer = window.setTimeout(() => flush(), Math.max(1_000, due - Date.now()))
    }

    void import("@/lib/client/upload-queue/browser").then(async (browser) => {
      if (cancelled) return

      const queue = browser.getUploadQueue(userId, workspaceId)

      queueRef.current = queue
      unsubscribe = queue.subscribe((value) => {
        if (previous > value.pending && !value.uploading) uploadedRef.current?.()
        previous = value.pending
        setSnapshot(value)
        schedule(value)
      })
      await queue.recover({ title: titleRef.current, activeCaptureIds: [...activeCaptureIds] }).catch(() => [])

      const first = await queue.snapshot()

      if (cancelled) return
      previous = first.pending
      setSnapshot(first)
      if (first.pending) void browser.requestBackgroundFlush()
      flush()
    })

    const onVisible = () => {
      if (document.visibilityState === "visible") flush()
    }
    const onOnline = () => flush(true)
    const onRequest = () => flush()
    const onWorkerMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === "flush-uploads") flush()
    }

    window.addEventListener("online", onOnline)
    window.addEventListener("meetsum:flush-uploads", onRequest)
    document.addEventListener("visibilitychange", onVisible)
    navigator.serviceWorker?.addEventListener("message", onWorkerMessage)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      unsubscribe?.()
      queueRef.current = null
      window.removeEventListener("online", onOnline)
      window.removeEventListener("meetsum:flush-uploads", onRequest)
      document.removeEventListener("visibilitychange", onVisible)
      navigator.serviceWorker?.removeEventListener("message", onWorkerMessage)
    }
  }, [flush, userId, workspaceId])

  const value = useMemo<UploadQueueContextValue>(
    () => ({
      snapshot,
      online,
      retry: () => flush(true),
      flushNow: () => flush(true),
      async saveToDevice(captureId) {
        const queue = queueRef.current
        const blob = await queue?.blobOf(captureId)
        const item = snapshot?.items.find((entry) => entry.captureId === captureId)

        if (!blob) return

        const url = URL.createObjectURL(blob)
        const link = document.createElement("a")

        link.href = url
        link.download = `meetsum-recording-${(item?.startedAt ?? captureId).replace(/[^0-9A-Za-z-]/g, "-")}.${
          (item?.mime ?? blob.type).startsWith("audio/mp4") ? "m4a" : "webm"
        }`
        link.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      },
      async discard(captureId) {
        await queueRef.current?.remove(captureId)
      },
      async clearAll() {
        await queueRef.current?.clearUser()
      },
    }),
    [flush, online, snapshot]
  )

  return <UploadQueueContext.Provider value={value}>{children}</UploadQueueContext.Provider>
}
