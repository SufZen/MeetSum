"use client"

/**
 * Chapters / outline (M5 D7): click a chapter to seek; the chapter under the
 * playhead is highlighted. A chapter whose start doesn't resolve to a real
 * segment gets no seek control (no citation, no claim).
 */
import { useMeetingPlayer } from "@/components/player/meeting-player-provider"
import { TimecodeChip } from "@/components/ui/meeting-atoms"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { Chapter } from "@/lib/intelligence"
import { usePlayer } from "@/lib/player/contract"
import { cn } from "@/lib/utils"

/** Index of the chapter containing `ms` (the last one starting at or before it). */
export function currentChapterIndex(chapters: readonly Chapter[], ms: number): number {
  let index = -1

  chapters.forEach((chapter, position) => {
    if (chapter.startMs <= ms) index = position
  })

  return index
}

export function ChapterList({
  chapters,
  dir,
  dictionary: t,
}: {
  chapters: readonly Chapter[]
  dir: "rtl" | "ltr"
  dictionary: Dictionary
}) {
  const player = useMeetingPlayer()
  const { seek, currentMs } = usePlayer()
  const current = player.available ? currentChapterIndex(chapters, currentMs) : -1

  return (
    <ol className="grid gap-1">
      {chapters.map((chapter, index) => {
        const resolved = player.resolve({ segmentId: chapter.startSegmentId, startMs: chapter.startMs })
        const active = index === current

        return (
          <li
            key={chapter.id}
            aria-current={active ? "true" : undefined}
            className={cn(
              "grid gap-1 rounded-md border border-transparent px-3 py-2 transition-colors duration-(--dur-2)",
              active ? "border-brand/30 bg-brand-soft" : "hover:bg-surface-2"
            )}
          >
            <div className="flex items-baseline gap-2">
              {resolved ? (
                <button
                  type="button"
                  onClick={() => seek(resolved.startMs, { segmentId: resolved.segmentId })}
                  className="shrink-0 rounded-xs focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
                  aria-label={`${chapter.title} ${Math.floor(resolved.startMs / 1000)}s`}
                >
                  <TimecodeChip seconds={resolved.startMs / 1000} />
                </button>
              ) : null}
              <span dir={dir} className="min-w-0 font-medium text-fg">
                {chapter.title}
              </span>
              {active ? <span className="ms-auto shrink-0 text-xs text-brand-text">{t.intelNowPlaying}</span> : null}
            </div>
            {chapter.summary ? (
              <p dir={dir} className="text-sm leading-6 text-fg-2">
                {chapter.summary}
              </p>
            ) : null}
            {chapter.bullets.length ? (
              <ul dir={dir} className="list-disc ps-5 text-sm leading-6 text-fg-2">
                {chapter.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
