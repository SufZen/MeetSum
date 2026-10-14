import { cookies, headers } from "next/headers"
import { notFound } from "next/navigation"
import type { ReactNode } from "react"

import { ClipShareView } from "@/components/clips/clip-share-view"
import { ShareChromeControls, type ShareChromeLabels } from "@/components/share/share-chrome-controls"
import { SharedMeetingPlayer } from "@/components/share/shared-meeting-player-lazy"
import { Button } from "@/components/ui/button"
import { INPUT_CLASS, LABEL_CLASS } from "@/components/ui/input-class"
import { getSessionSecret } from "@/lib/auth/session"
import { buildClipSharePayload, clipShareLocale } from "@/lib/clips/share-payload"
import { getDictionary, type Dictionary } from "@/lib/i18n/dictionaries"
import { formatDate, formatDuration, type Fmt } from "@/lib/i18n/format"
import { directionFor, fixHebrewTypography } from "@/lib/i18n/hebrew-text"
import { LOCALE_COOKIE, type SupportedLocale } from "@/lib/i18n/locales"
import { pluralMessage } from "@/lib/i18n/messages"
import { getShareTimeZone } from "@/lib/i18n/server"
import { SHARE_ACCESS_COOKIE } from "@/lib/sharing/share-access"
import { getShareDocumentLocale } from "@/lib/sharing/share-locale"
import { loadSharePageData, type SharePayload } from "@/lib/sharing/share-payload"
import { resolveShareViewerLocale, shareLocaleDir } from "@/lib/sharing/share-viewer-locale"

import { loadClipShare, loadShare } from "./load-share"

export const dynamic = "force-dynamic"

type SearchParams = { [key: string]: string | string[] | undefined }

const PRIORITY_KEYS: Record<string, keyof Dictionary> = {
  low: "sharePagePriorityLow",
  normal: "sharePagePriorityNormal",
  high: "sharePagePriorityHigh",
  urgent: "sharePagePriorityUrgent",
}

const GATE_ERRORS: Record<string, keyof Dictionary> = {
  invalid: "sharePagePasswordInvalid",
  rate_limited: "sharePageRateLimited",
}

/** A message with one `{placeholder}` filled by a node (names, dates and brands go in <bdi>). */
function withNode(template: string, node: ReactNode): ReactNode {
  const [before = "", after = ""] = template.split(/\{\w+\}/)

  return (
    <>
      {before}
      {node}
      {after}
    </>
  )
}

function chromeLabels(t: Dictionary): ShareChromeLabels {
  return {
    language: t.sharePageLanguageToggle,
    theme: t.sharePageThemeToggle,
    languageHe: t.sharePageLanguageHe,
    languageEn: t.sharePageLanguageEn,
  }
}

/** Brand line plus the language and theme toggles. */
function ShareHeader({ locale, t }: { locale: SupportedLocale; t: Dictionary }) {
  return (
    <header className="mb-6 flex items-center justify-between gap-3">
      <p className="text-xs font-semibold text-brand-text">{t.sharePageTitle}</p>
      <ShareChromeControls locale={locale} labels={chromeLabels(t)} />
    </header>
  )
}

/**
 * Public meeting share page (M4, localized and themed in M9 B7). The chrome
 * (labels, password gate, dates) follows the viewer's language
 * (`?lang=` → cookie → Accept-Language → meeting → he); every content block
 * keeps the meeting language for `lang`/`dir`. Clip tokens render the clip
 * view only.
 */
export default async function PublicMeetingSharePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<SearchParams>
}) {
  const { token } = await params
  const [sp, cookieStore, headerStore] = await Promise.all([searchParams, cookies(), headers()])
  const viewer = (meetingLocale: SupportedLocale) =>
    resolveShareViewerLocale({
      lang: sp.lang,
      cookie: cookieStore.get(LOCALE_COOKIE)?.value,
      acceptLanguage: headerStore.get("accept-language"),
      meetingLocale,
    })
  // M5: a clip token renders only the clip and never opens the meeting —
  // a clip token that fails any gate is a plain 404.
  const clip = await loadClipShare(token)
  // A's zone chain: the signed-in viewer's zone, else the shared meeting's workspace zone, else env.
  const shareWorkspaceId =
    clip.kind === "clip"
      ? clip.view.clip.workspaceId
      : clip.kind === "not_clip"
        ? (await loadShare(token))?.meeting.workspaceId
        : undefined
  const timeZone = await getShareTimeZone(shareWorkspaceId)

  if (clip.kind === "clip") {
    const locale = viewer(clipShareLocale(clip.view.meeting.language).lang)

    return (
      <div lang={locale} dir={shareLocaleDir(locale)}>
        <ClipShareView
          token={token}
          payload={buildClipSharePayload(clip.view)}
          locale={locale}
          timeZone={timeZone}
          controls={<ShareChromeControls locale={locale} labels={chromeLabels(getDictionary(locale))} />}
        />
      </div>
    )
  }
  if (clip.kind === "clip_unavailable") notFound()

  // Password gate: the password is POSTed to /api/share/:token/verify, which
  // sets a short-lived signed httpOnly cookie; it never appears in the URL.
  // The loader checks it before deriving anything from the meeting.
  const data = await loadSharePageData(token, {
    lookup: loadShare,
    accessCookie: cookieStore.get(SHARE_ACCESS_COOKIE)?.value,
    secret: getSessionSecret,
  })

  if (!data) notFound()

  // The gate may only use the meeting's language as a chrome fallback.
  const locale = viewer(
    data.status === "ok" ? data.payload.lang : getShareDocumentLocale((await loadShare(token))?.meeting).lang
  )
  const dir = shareLocaleDir(locale)
  const t = getDictionary(locale)

  if (data.status === "password_required") {
    const errorKey = typeof sp.error === "string" ? GATE_ERRORS[sp.error] : undefined

    return (
      <main lang={locale} dir={dir} className="min-h-screen bg-canvas px-4 py-8 text-fg sm:px-5">
        <div className="mx-auto w-full max-w-md">
          <ShareHeader locale={locale} t={t} />
          <section className="rounded-xl border border-line bg-surface p-6 shadow-1 sm:p-8">
            <h1 className="mb-2 text-xl font-semibold">{t.sharePagePasswordTitle}</h1>
            <p className="mb-6 text-sm text-fg-3">{t.sharePagePasswordHint}</p>
            <form method="POST" action={`/api/share/${encodeURIComponent(token)}/verify`} className="grid gap-3">
              {/* Native controls: the gate ships no Field runtime (M10 C). */}
              <label htmlFor="share-password" className={LABEL_CLASS}>
                {t.sharePagePasswordLabel}
              </label>
              <input
                className={INPUT_CLASS}
                data-slot="input"
                id="share-password"
                type="password"
                name="password"
                autoComplete="current-password"
                autoFocus
                required
                maxLength={128}
                dir="auto"
                aria-invalid={errorKey ? true : undefined}
                aria-describedby={errorKey ? "share-password-error" : undefined}
              />
              {errorKey ? (
                <p id="share-password-error" role="alert" className="text-sm text-danger-text">
                  {t[errorKey]}
                </p>
              ) : null}
              <Button type="submit" className="mt-1 w-full">
                {t.sharePagePasswordSubmit}
              </Button>
            </form>
          </section>
        </div>
      </main>
    )
  }

  // Everything below renders from the section-gated payload only; the
  // hydrated meeting never reaches the HTML or the client island's props.
  return <SharedMeeting token={token} payload={data.payload} locale={locale} timeZone={timeZone} t={t} />
}

function SharedMeeting({
  token,
  payload,
  locale,
  timeZone,
  t,
}: {
  token: string
  payload: SharePayload
  locale: SupportedLocale
  timeZone: string
  t: Dictionary
}) {
  const fmt: Fmt = { locale, timeZone }
  const dir = shareLocaleDir(locale)
  const { transcript, media } = payload
  const contentLang = payload.lang
  const contentDir = (text: string) => directionFor(payload.language, text)
  const typeset = (text: string) => fixHebrewTypography(text, { base: contentDir(text) })
  const date = formatDate(payload.startedAt, fmt, "dateTime")

  return (
    <main lang={locale} dir={dir} className="min-h-screen bg-canvas px-4 py-8 text-fg sm:px-5">
      <div className="mx-auto max-w-4xl">
        <ShareHeader locale={locale} t={t} />
        <article className="rounded-xl border border-line bg-surface p-6 shadow-1 sm:p-8">
          <div className="mb-8 border-b border-line pb-6">
            <h1 lang={contentLang} dir={contentDir(payload.title)} className="text-3xl font-semibold leading-tight">
              {typeset(payload.title)}
            </h1>
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-3">
              {date ? <time dateTime={payload.startedAt}>{date}</time> : null}
              {payload.durationMs !== undefined ? <span>{formatDuration(payload.durationMs, fmt, "long")}</span> : null}
              {payload.participants ? (
                <span>{pluralMessage(t, locale, "sharePageParticipants", payload.participants.length)}</span>
              ) : null}
            </div>
            {payload.participants?.length ? (
              <ul className="mt-4 flex flex-wrap gap-2">
                {payload.participants.map((participant) => (
                  <li key={participant} className="rounded-full bg-surface-2 px-3 py-1 text-sm">
                    <bdi>{participant}</bdi>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {payload.overview !== undefined ? (
            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold">{t.sharePageOverview}</h2>
              {payload.overview ? (
                <p lang={contentLang} dir={contentDir(payload.overview)} className="leading-7 text-fg-2">
                  {typeset(payload.overview)}
                </p>
              ) : (
                <p className="text-fg-3">{t.sharePageNoSummary}</p>
              )}
            </section>
          ) : null}

          {payload.decisions ? (
            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold">{t.sharePageDecisions}</h2>
              {payload.decisions.length ? (
                <ul className="list-disc space-y-2 ps-5 text-fg-2">
                  {payload.decisions.map((decision) => (
                    <li lang={contentLang} dir={contentDir(decision)} key={decision}>
                      {typeset(decision)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-fg-3">{t.sharePageNoDecisions}</p>
              )}
            </section>
          ) : null}

          {payload.actionItems ? (
            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold">{t.sharePageActionItems}</h2>
              <div className="space-y-2">
                {payload.actionItems.map((item) => {
                  const priority = item.priority ? PRIORITY_KEYS[item.priority] : undefined

                  return (
                    <div className="rounded-md border border-line p-3 text-sm" key={item.key}>
                      <div lang={contentLang} dir={contentDir(item.title)} className="font-medium">
                        {typeset(item.title)}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-2 text-fg-3">
                        <span>{item.owner ? <bdi>{item.owner}</bdi> : t.sharePageUnassigned}</span>
                        {item.dueDate ? <span>{withNode(t.sharePageDue, <bdi>{item.dueDate}</bdi>)}</span> : null}
                        {priority ? <span>{t[priority]}</span> : null}
                      </div>
                    </div>
                  )
                })}
                {!payload.actionItems.length ? <p className="text-fg-3">{t.sharePageNoActionItems}</p> : null}
              </div>
            </section>
          ) : null}

          {transcript?.transcription ? (
            <p className="mb-4 rounded-md border border-line bg-surface-2 p-3 text-sm text-fg-2">
              {withNode(
                t.sharePageTranscribedBy,
                <bdi>
                  {transcript.transcription.provider}
                  {transcript.transcription.model ? ` · ${transcript.transcription.model}` : ""}
                </bdi>
              )}
            </p>
          ) : null}

          {media?.available || transcript ? (
            <SharedMeetingPlayer
              token={token}
              locale={locale}
              dictionary={t}
              language={payload.language}
              media={media}
              segments={transcript?.segments ?? []}
              speakers={transcript?.speakers ?? []}
              durationMs={payload.durationMs}
              showTranscript={Boolean(transcript)}
            />
          ) : null}
        </article>
      </div>
    </main>
  )
}
