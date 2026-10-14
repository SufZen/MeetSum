"use client"

/**
 * Offline recording upload queue indicator (docs/parity/m9.md D5; mounted in
 * `top-command-bar`). Nothing when the queue is empty; otherwise a count
 * with a popover (`PendingUploadsPopover`, its own chunk since M10 C) listing
 * each recording, a retry, and "save to device" / delete for recordings the
 * server refused permanently. While the chunk loads, or if it can't (opened
 * offline before it was ever cached), a static count stays in its place.
 */
import { CloudUploadIcon } from "lucide-react"
import { lazy, Suspense } from "react"

import { useOptionalI18n } from "@/components/i18n-provider"
import { useUploadQueue } from "@/components/pwa/upload-queue-provider"
import { Button } from "@/components/ui/button"

function StaticCount() {
  const queue = useUploadQueue()
  const i18n = useOptionalI18n()
  const pending = queue?.snapshot?.pending ?? 0

  if (!i18n || pending === 0) return null

  const label = i18n.plural("pwaPendingUploads", pending, { count: i18n.fmt.number(pending) })

  return (
    <Button variant="ghost" size="sm" className="h-8 gap-1.5 rounded-md text-fg-2" aria-label={label} title={label} aria-busy>
      <CloudUploadIcon aria-hidden="true" className="size-4" />
      <span className="font-mono text-xs tabular-nums" dir="ltr">
        {i18n.fmt.number(pending)}
      </span>
    </Button>
  )
}

const PendingUploadsPopover = lazy(() =>
  import("@/components/pwa/pending-uploads-popover")
    .then((mod) => ({ default: mod.PendingUploadsPopover }))
    .catch(() => ({ default: StaticCount }))
)

export function PendingUploadsIndicator() {
  const queue = useUploadQueue()

  if (!queue?.snapshot || queue.snapshot.pending === 0) return null

  return (
    <Suspense fallback={<StaticCount />}>
      <PendingUploadsPopover />
    </Suspense>
  )
}
