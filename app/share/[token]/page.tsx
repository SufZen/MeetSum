import { cookies } from "next/headers"
import { notFound } from "next/navigation"

import { ClipShareView } from "@/components/clips/clip-share-view"
import { SharedMeetingPlayer } from "@/components/share/shared-meeting-player"
import { getSessionSecret } from "@/lib/auth/session"
import { buildClipSharePayload } from "@/lib/clips/share-payload"
import { formatDurationLabel } from "@/lib/meetings/duration"
import { SHARE_ACCESS_COOKIE } from "@/lib/sharing/share-access"
import { loadSharePageData } from "@/lib/sharing/share-payload"

import { loadClipShare, loadShare } from "./load-share"

const SHARE_ERROR_MESSAGES: Record<string, string> = {
  invalid: "Incorrect password. Please try again.",
  rate_limited: "Too many attempts. Please wait a minute and try again.",
}

export default async function PublicMeetingSharePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { token } = await params

  // M5: a clip token renders only the clip and never opens the meeting —
  // a clip token that fails any gate is a plain 404.
  const clip = await loadClipShare(token)

  if (clip.kind === "clip") {
    return <ClipShareView token={token} payload={buildClipSharePayload(clip.view)} />
  }
  if (clip.kind === "clip_unavailable") notFound()

  const sp = await searchParams
  const cookieStore = await cookies()
  // Password gate: the password is POSTed to /api/share/:token/verify, which
  // sets a short-lived signed httpOnly cookie; it never appears in the URL.
  // The loader checks it before deriving anything from the meeting.
  const data = await loadSharePageData(token, {
    lookup: loadShare,
    accessCookie: cookieStore.get(SHARE_ACCESS_COOKIE)?.value,
    secret: getSessionSecret,
  })

  if (!data) notFound()

  if (data.status === "password_required") {
    const errorMessage =
      typeof sp.error === "string" ? SHARE_ERROR_MESSAGES[sp.error] : undefined

    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas px-5 py-8 text-fg">
        <div className="w-full max-w-md rounded-lg border border-line bg-surface p-8 shadow-sm">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-brand-text">
            MeetSum shared meeting
          </div>
          <h1 className="mb-2 text-xl font-semibold">Password Required</h1>
          <p className="mb-6 text-sm text-fg-3">
            This shared meeting is password-protected. Please enter the password to continue.
          </p>
          <form
            method="POST"
            action={`/api/share/${encodeURIComponent(token)}/verify`}
          >
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              aria-label="Password"
              autoFocus
              required
              placeholder="Enter password"
              className="mb-4 w-full rounded-md border border-line bg-surface-2 px-4 py-3 text-sm"
            />
            <button
              type="submit"
              className="w-full rounded-md bg-brand px-4 py-3 text-sm font-medium text-white"
            >
              Access Meeting
            </button>
            {errorMessage ? (
              <p
                role="alert"
                className="mt-3 text-center text-sm text-danger-text"
              >
                {errorMessage}
              </p>
            ) : null}
          </form>
        </div>
      </main>
    )
  }

  // Everything below renders from the section-gated payload only; the
  // hydrated meeting never reaches the HTML or the client island's props.
  const { payload } = data
  const { lang, transcript, media } = payload

  return (
    <main className="min-h-screen bg-canvas px-5 py-8 text-fg">
      <article className="mx-auto max-w-4xl rounded-lg border border-line bg-surface p-8 shadow-sm">
        <div className="mb-8 border-b border-line pb-6">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-brand-text">
            MeetSum shared meeting
          </div>
          <h1 dir="auto" className="text-3xl font-semibold leading-tight">{payload.title}</h1>
          <div className="mt-4 flex flex-wrap gap-3 text-sm text-fg-3">
            <span>{new Date(payload.startedAt).toLocaleString()}</span>
            <span>{payload.source.replaceAll("_", " ")}</span>
            <span>{payload.language}</span>
            <span className="[unicode-bidi:isolate]">{formatDurationLabel(payload.durationMs, lang)}</span>
            {payload.participants ? (
              <span>{payload.participants.length} participants</span>
            ) : null}
          </div>
          {payload.participants?.length ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {payload.participants.map((participant) => (
                <bdi
                  className="rounded-full bg-surface-2 px-3 py-1 text-sm"
                  key={participant}
                >
                  {participant}
                </bdi>
              ))}
            </div>
          ) : null}
        </div>

        {payload.overview !== undefined ? (
          <section className="mb-8">
            <h2 className="mb-3 text-xl font-semibold">Overview</h2>
            <p dir="auto" className="leading-7 text-fg-2">
              {payload.overview || "No summary is available yet."}
            </p>
          </section>
        ) : null}

        {payload.decisions ? (
          <section className="mb-8">
            <h2 className="mb-3 text-xl font-semibold">Decisions</h2>
            <ul className="list-disc space-y-2 ps-5 text-fg-2">
              {(payload.decisions.length
                ? payload.decisions
                : ["No decisions extracted yet."]
              ).map((decision) => (
                <li dir="auto" key={decision}>
                  {decision}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {payload.actionItems ? (
          <section className="mb-8">
            <h2 className="mb-3 text-xl font-semibold">Action Items</h2>
            <div className="space-y-2">
              {payload.actionItems.map((item) => (
                <div
                  className="rounded-md border border-line p-3 text-sm"
                  key={item.key}
                >
                  <div dir="auto" className="font-medium">
                    {item.title}
                  </div>
                  <div className="mt-1 text-fg-3">
                    {item.owner ? <bdi>{item.owner}</bdi> : "Unassigned"}
                    {item.dueDate ? ` · Due ${item.dueDate}` : ""}
                    {item.priority ? ` · ${item.priority}` : ""}
                  </div>
                </div>
              ))}
              {!payload.actionItems.length ? (
                <p className="text-fg-3">
                  No action items extracted yet.
                </p>
              ) : null}
            </div>
          </section>
        ) : null}

        {transcript?.transcription ? (
          <div className="mb-4 rounded-md border border-line bg-surface-2 p-3 text-sm">
            <div className="font-medium">
              Transcription provided by {transcript.transcription.provider}
              {transcript.transcription.model ? ` (${transcript.transcription.model})` : ""}
            </div>
          </div>
        ) : null}

        {media?.available || transcript ? (
          <SharedMeetingPlayer
            token={token}
            locale={lang}
            language={payload.language}
            media={media}
            segments={transcript?.segments ?? []}
            speakers={transcript?.speakers ?? []}
            durationMs={payload.durationMs}
            showTranscript={Boolean(transcript)}
          />
        ) : null}
      </article>
    </main>
  )
}
