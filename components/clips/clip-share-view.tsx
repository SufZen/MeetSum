/**
 * Public clip page body (M5 C2). Renders only the clip-scoped payload from
 * `buildClipSharePayload` — no ids, emails or storage keys. The audio is
 * proxied by `/api/share/<token>/media` (never a presigned URL). Server
 * component: no client JavaScript.
 */
import { formatClipClock } from "@/lib/clips/range"
import type { ClipSharePayload } from "@/lib/clips/share-payload"
import { clipsMessagesEn, clipsMessagesHe } from "@/lib/i18n/m5/clips"

export function ClipShareView({ token, payload }: { token: string; payload: ClipSharePayload }) {
  const t = payload.lang === "he" ? clipsMessagesHe : clipsMessagesEn
  const startedAt = new Date(payload.startedAt)
  const date = Number.isNaN(startedAt.getTime())
    ? undefined
    : new Intl.DateTimeFormat(payload.lang === "he" ? "he-IL" : "en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(startedAt)

  return (
    <main className="min-h-screen bg-canvas px-4 py-8 text-fg sm:px-5">
      <article className="mx-auto max-w-(--measure) rounded-xl border border-line bg-surface p-6 shadow-1 sm:p-8">
        <p className="mb-3 text-xs font-semibold text-brand-text">{t.clipsShareHeading}</p>
        <h1 dir={payload.textDir} className="text-xl font-semibold leading-tight">
          {payload.title}
        </h1>
        <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-fg-3">
          <span>
            {t.clipsShareFrom}: <bdi>{payload.meetingTitle}</bdi>
          </span>
          {date ? <span>{date}</span> : null}
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
