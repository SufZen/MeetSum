"use client"

/**
 * Offline recording upload queue indicator (docs/parity/m9.md D5; mounted in
 * `top-command-bar`). Nothing when the queue is empty; otherwise a count
 * with a popover listing each recording, a retry, and "save to device" /
 * delete for recordings the server refused permanently.
 */
import { CloudUploadIcon, DownloadIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"

import { useOptionalI18n } from "@/components/i18n-provider"
import { useUploadQueue } from "@/components/pwa/upload-queue-provider"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"

export function PendingUploadsIndicator() {
  const queue = useUploadQueue()
  const i18n = useOptionalI18n()
  const snapshot = queue?.snapshot

  if (!queue || !i18n || !snapshot || snapshot.pending === 0) return null

  const { t, plural, fmt } = i18n
  const label = plural("pwaPendingUploads", snapshot.pending, { count: fmt.number(snapshot.pending) })

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 rounded-md text-fg-2" aria-label={label} title={label} />
        }
      >
        {snapshot.uploading ? <Spinner className="size-4" /> : <CloudUploadIcon aria-hidden="true" className="size-4" />}
        <span className="font-mono text-xs tabular-nums" dir="ltr">
          {fmt.number(snapshot.pending)}
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("pwaPendingTitle")}</h2>
          <Button variant="outline" size="sm" onClick={queue.retry} disabled={!queue.online || Boolean(snapshot.uploading)}>
            <RefreshCwIcon data-icon="inline-start" className="size-4" />
            {t("pwaRetryUpload")}
          </Button>
        </div>
        {snapshot.pausedForAuth ? (
          <p role="status" className="rounded-md bg-warn-soft px-2 py-1.5 text-xs text-warn-text">
            {t("pwaSignInToFinish")}
          </p>
        ) : null}
        <ul className="grid gap-2">
          {snapshot.items.map((item) => (
            <li key={item.captureId} className="grid gap-1 rounded-md border border-line p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">
                  <bdi>{item.recovered ? t("pwaRecoveredRecording") : item.title}</bdi>
                </span>
                {snapshot.uploading === item.captureId ? <Spinner className="size-3.5" /> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                <time dateTime={item.startedAt}>{fmt.date(item.startedAt, "dateTime")}</time>
              </div>
              {item.status === "failed-permanent" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-destructive">{t("pwaUploadFailed")}</span>
                  <Button variant="outline" size="sm" onClick={() => void queue.saveToDevice(item.captureId)}>
                    <DownloadIcon data-icon="inline-start" className="size-4" />
                    {t("pwaSaveToDevice")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void queue.discard(item.captureId)}>
                    <Trash2Icon data-icon="inline-start" className="size-4" />
                    {t("pwaDiscard")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
