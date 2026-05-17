import { notFound } from "next/navigation"

import { meetingRepository } from "@/lib/meetings/store"

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
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const result = await meetingRepository.getShareByToken(token)

  if (!result) notFound()

  const { meeting, share } = result
  const includes = new Set(share.includedSections)
  const participants =
    meeting.participantDetails?.map((participant) => participant.name) ??
    meeting.participants

  return (
    <main className="min-h-screen bg-[var(--app-bg)] px-5 py-8 text-[var(--text-primary)]">
      <article className="mx-auto max-w-4xl rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
        <div className="mb-8 border-b border-[var(--border)] pb-6">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--primary)]">
            MeetSum shared meeting
          </div>
          <h1 className="text-3xl font-semibold leading-tight">{meeting.title}</h1>
          <div className="mt-4 flex flex-wrap gap-3 text-sm text-[var(--text-muted)]">
            <span>{new Date(meeting.startedAt).toLocaleString()}</span>
            <span>{meeting.source.replaceAll("_", " ")}</span>
            <span>{meeting.language}</span>
            <span>{participants.length} participants</span>
          </div>
          {includes.has("participants") && participants.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {participants.map((participant) => (
                <span
                  className="rounded-full bg-[var(--surface-subtle)] px-3 py-1 text-sm"
                  key={participant}
                >
                  {participant}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {includes.has("summary") ? (
          <section className="mb-8">
            <h2 className="mb-3 text-xl font-semibold">Overview</h2>
            <p className="leading-7 text-[var(--text-secondary)]">
              {meeting.summary?.overview ?? "No summary is available yet."}
            </p>
          </section>
        ) : null}

        {includes.has("decisions") ? (
          <section className="mb-8">
            <h2 className="mb-3 text-xl font-semibold">Decisions</h2>
            <ul className="space-y-2 text-[var(--text-secondary)]">
              {(meeting.summary?.decisions.length
                ? meeting.summary.decisions
                : ["No decisions extracted yet."]
              ).map((decision) => (
                <li key={decision}>• {decision}</li>
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
                  <div className="font-medium">{item.title}</div>
                  <div className="mt-1 text-[var(--text-muted)]">
                    {item.owner ?? "Unassigned"}
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
            <div className="space-y-3">
              {(meeting.transcript?.length ? meeting.transcript : []).map(
                (segment) => (
                  <div
                    className="rounded-md bg-[var(--surface-subtle)] p-3"
                    key={segment.id}
                  >
                    <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">
                      {formatMs(segment.startMs)} · {segment.speaker}
                    </div>
                    <p className="text-sm leading-6">{segment.text}</p>
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
      </article>
    </main>
  )
}
