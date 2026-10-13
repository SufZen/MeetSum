import { cookies } from "next/headers"
import { notFound } from "next/navigation"

import { getSessionSecret } from "@/lib/auth/session"
import {
  SHARE_ACCESS_COOKIE,
  verifyShareAccessCookie,
} from "@/lib/sharing/share-access"

import { loadShare } from "./load-share"

const SHARE_ERROR_MESSAGES: Record<string, string> = {
  invalid: "Incorrect password. Please try again.",
  rate_limited: "Too many attempts. Please wait a minute and try again.",
}

function formatMs(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0")
  const seconds = (totalSeconds % 60).toString().padStart(2, "0")

  return `${minutes}:${seconds}`
}

export default async function PublicMeetingSharePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { token } = await params
  const sp = await searchParams
  const result = await loadShare(token)

  if (!result) notFound()

  const { meeting, share } = result

  // Password gate: the password is POSTed to /api/share/:token/verify, which
  // sets a short-lived signed httpOnly cookie; it never appears in the URL.
  if (share.passwordHash) {
    const cookieStore = await cookies()
    const isValid = verifyShareAccessCookie(
      cookieStore.get(SHARE_ACCESS_COOKIE)?.value,
      {
        token,
        passwordHash: share.passwordHash,
        secret: getSessionSecret(),
      }
    )
    const errorMessage =
      typeof sp.error === "string" ? SHARE_ERROR_MESSAGES[sp.error] : undefined

    if (!isValid) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] px-5 py-8 text-[var(--text-primary)]">
          <div className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
            <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--primary)]">
              MeetSum shared meeting
            </div>
            <h1 className="mb-2 text-xl font-semibold">Password Required</h1>
            <p className="mb-6 text-sm text-[var(--text-muted)]">
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
                className="mb-4 w-full rounded-md border border-[var(--border)] bg-[var(--surface-subtle)] px-4 py-3 text-sm"
              />
              <button
                type="submit"
                className="w-full rounded-md bg-[var(--primary)] px-4 py-3 text-sm font-medium text-white"
              >
                Access Meeting
              </button>
              {errorMessage ? (
                <p
                  role="alert"
                  className="mt-3 text-center text-sm text-[var(--status-error)]"
                >
                  {errorMessage}
                </p>
              ) : null}
            </form>
          </div>
        </main>
      )
    }
  }

  const includes = new Set(share.includedSections)
  const participants =
    meeting.participantDetails?.map((participant) => participant.name) ??
    meeting.participants
  const transcribeRun = meeting.aiRuns?.find((r) => r.task === "audio.transcribe")

  return (
    <main className="min-h-screen bg-[var(--app-bg)] px-5 py-8 text-[var(--text-primary)]">
      <article className="mx-auto max-w-4xl rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
        <div className="mb-8 border-b border-[var(--border)] pb-6">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--primary)]">
            MeetSum shared meeting
          </div>
          <h1 dir="auto" className="text-3xl font-semibold leading-tight">{meeting.title}</h1>
          <div className="mt-4 flex flex-wrap gap-3 text-sm text-[var(--text-muted)]">
            <span>{new Date(meeting.startedAt).toLocaleString()}</span>
            <span>{meeting.source.replaceAll("_", " ")}</span>
            <span>{meeting.language}</span>
            <span>{participants.length} participants</span>
          </div>
          {includes.has("participants") && participants.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {participants.map((participant) => (
                <bdi
                  className="rounded-full bg-[var(--surface-subtle)] px-3 py-1 text-sm"
                  key={participant}
                >
                  {participant}
                </bdi>
              ))}
            </div>
          ) : null}
        </div>

        {includes.has("summary") ? (
          <section className="mb-8">
            <h2 className="mb-3 text-xl font-semibold">Overview</h2>
            <p dir="auto" className="leading-7 text-[var(--text-secondary)]">
              {meeting.summary?.overview ?? "No summary is available yet."}
            </p>
          </section>
        ) : null}

        {includes.has("decisions") ? (
          <section className="mb-8">
            <h2 className="mb-3 text-xl font-semibold">Decisions</h2>
            <ul className="list-disc space-y-2 ps-5 text-[var(--text-secondary)]">
              {(meeting.summary?.decisions.length
                ? meeting.summary.decisions
                : ["No decisions extracted yet."]
              ).map((decision) => (
                <li dir="auto" key={decision}>
                  {decision}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {includes.has("action_items") ? (
          <section className="mb-8">
            <h2 className="mb-3 text-xl font-semibold">Action Items</h2>
            <div className="space-y-2">
              {(meeting.summary?.actionItems.length
                ? meeting.summary.actionItems
                : []
              ).map((item) => (
                <div
                  className="rounded-md border border-[var(--border)] p-3 text-sm"
                  key={item.id}
                >
                  <div dir="auto" className="font-medium">
                    {item.title}
                  </div>
                  <div className="mt-1 text-[var(--text-muted)]">
                    {item.owner ? <bdi>{item.owner}</bdi> : "Unassigned"}
                    {item.dueDate ? ` · Due ${item.dueDate}` : ""}
                    {item.priority ? ` · ${item.priority}` : ""}
                  </div>
                </div>
              ))}
              {!meeting.summary?.actionItems.length ? (
                <p className="text-[var(--text-muted)]">
                  No action items extracted yet.
                </p>
              ) : null}
            </div>
          </section>
        ) : null}

        {includes.has("transcript") ? (
          <section>
            <h2 className="mb-3 text-xl font-semibold">Transcript</h2>
            {transcribeRun ? (
              <div className="mb-4 rounded-md border border-[var(--border)] bg-[var(--surface-subtle)] p-3 text-sm">
                <div className="font-medium">
                  Transcription provided by {transcribeRun.provider}
                  {transcribeRun.model ? ` (${transcribeRun.model})` : ""}
                </div>
                {transcribeRun.latencyMs ? (
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    Completed in {(transcribeRun.latencyMs / 1000).toFixed(1)}s
                  </div>
                ) : null}
                {transcribeRun.metadata?.fallbackUsed ? (
                  <div className="mt-1 text-xs text-[var(--status-warning)]">
                    Fallback used after {transcribeRun.metadata.attemptedProvider as string}. Reason: {(transcribeRun.metadata.fallbackReason as string) || "Unknown error"}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="space-y-3">
              {(meeting.transcript?.length ? meeting.transcript : []).map(
                (segment) => (
                  <div
                    className="rounded-md bg-[var(--surface-subtle)] p-3"
                    key={segment.id}
                  >
                    <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">
                      {formatMs(segment.startMs)} · <bdi>{segment.speaker}</bdi>
                    </div>
                    <p dir="auto" className="text-sm leading-6">
                      {segment.text}
                    </p>
                  </div>
                )
              )}
              {!meeting.transcript?.length ? (
                <p className="text-[var(--text-muted)]">
                  No transcript is available yet.
                </p>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* Processing metadata footer */}
        {meeting.aiRuns?.length ? (
          <footer className="mt-10 border-t border-[var(--border)] pt-6">
            <h3 className="mb-3 text-sm font-semibold text-[var(--text-muted)]">
              Processing metadata
            </h3>
            <div className="grid gap-2 text-xs text-[var(--text-muted)] sm:grid-cols-2 lg:grid-cols-3">
              {meeting.aiRuns
                .filter((run) => run.status === "completed")
                .map((run) => (
                  <div
                    key={run.id}
                    className="rounded-md border border-[var(--border)] bg-[var(--surface-subtle)] p-2"
                  >
                    <div className="font-medium text-[var(--text-secondary)]">
                      {run.task.replace(/\./g, " · ")}
                    </div>
                    <div className="mt-1">
                      {run.provider}
                      {run.model ? ` · ${run.model}` : ""}
                      {run.latencyMs ? ` · ${(run.latencyMs / 1000).toFixed(1)}s` : ""}
                    </div>
                  </div>
                ))}
            </div>
          </footer>
        ) : null}
      </article>
    </main>
  )
}
