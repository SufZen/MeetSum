/**
 * Public clip page body (M5 C2). Renders only the clip-scoped payload from
 * `buildClipSharePayload` — no ids, emails or storage keys. The audio is
 * proxied by `/api/share/<token>/media` (never a presigned URL). Server
 * component (the optional `controls` slot is the share page's client
 * toggles). M9: labels follow the viewer's `locale`, the date goes through
 * lib/i18n/format.ts in `timeZone`; clip text keeps the meeting language.
 */
import type { ReactNode } from "react"

import { formatClipClock } from "@/lib/clips/range"
import type { ClipSharePayload } from "@/lib/clips/share-payload"
import { formatDate } from "@/lib/i18n/format"
import { fixHebrewTypography } from "@/lib/i18n/hebrew-text"
import { clipsMessagesEn, clipsMessagesHe } from "@/lib/i18n/m5/clips"

export function ClipShareView({
  token,
  payload,
  locale = payload.lang,
  timeZone = "UTC",
  controls,
}: {
  token: string
  payload: ClipSharePayload
  /** The viewer's chrome locale; defaults to the clip's meeting language. */
  locale?: "he" | "en"
  timeZone?: string
  controls?: ReactNode
}) {
  const t = locale === "he" ? clipsMessagesHe : clipsMessagesEn
  const date = formatDate(payload.startedAt, { locale, timeZone }, "dateTime") || undefined
  const textBase = payload.textDir === "auto" ? undefined : payload.textDir

  return (
    <main className="min-h-screen bg-canvas px-4 py-8 text-fg sm:px-5">
      <article className="mx-auto max-w-(--measure) rounded-xl border border-line bg-surface p-6 shadow-1 sm:p-8">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-xs font-semibold text-brand-text">{t.clipsShareHeading}</p>
          {controls}
        </div>
        <h1 dir={payload.textDir} className="text-xl font-semibold leading-tight">
          {fixHebrewTypography(payload.title, { base: textBase })}
        </h1>
        <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-fg-3">
          <span>
            {t.clipsShareFrom}: <bdi>{payload.meetingTitle}</bdi>
          </span>
          {date ? <time dateTime={payload.startedAt}>{date}</time> : null}
          <span className="font-mono tabular-nums [direction:ltr] [unicode-bidi:isolate]">
            {formatClipClock(payload.offsetMs)} · {formatClipClock(payload.durationMs)}
          </span>
        </p>

        <div className="mt-6">
          {payload.audioReady ? (
            <audio
              controls
              preload="metadata"
              src={`/api/share/${encodeURIComponent(token)}/media`}
              className="w-full"
              aria-label={payload.title}
            />
          ) : (
            <p role="status" className="rounded-lg bg-surface-2 px-4 py-3 text-sm text-fg-3">
              {t.clipsShareNoAudio}
            </p>
          )}
        </div>

        {payload.excerpt ? (
          <section className="mt-6">
            <h2 className="mb-2 text-sm font-semibold text-fg-2">{t.clipsShareExcerpt}</h2>
            <blockquote
              dir={payload.textDir}
              lang={payload.textDir === "auto" ? undefined : payload.language}
              className="border-s-2 border-line-strong ps-4 text-md text-fg-2"
            >
              {payload.excerpt}
            </blockquote>
          </section>
        ) : null}
      </article>
    </main>
  )
}
