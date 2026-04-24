import { Badge } from "@/components/ui/badge"
import type { TranscriptSegment } from "@/lib/meetings/repository"

function formatTime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

export function TranscriptTimeline({
  segments,
}: {
  segments?: TranscriptSegment[]
}) {
  if (!segments?.length) {
    return (
      <div className="flex min-h-56 items-center justify-center rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        Transcript segments will appear here after upload, Drive import, or
        recorder processing.
      </div>
    )
  }

  return (
    <div className="grid gap-2">
      {segments.map((segment) => (
        <article
          key={segment.id}
          className="grid gap-2 rounded-md border bg-card p-3 text-sm"
        >
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-medium">{segment.speaker}</span>
              {segment.language && (
                <Badge variant="secondary" className="h-6 rounded-sm">
                  {segment.language}
                </Badge>
              )}
            </div>
            <span className="font-mono text-xs text-muted-foreground">
              {formatTime(segment.startMs)}
            </span>
          </div>
          <p className="leading-6 text-muted-foreground">{segment.text}</p>
        </article>
      ))}
    </div>
  )
}
