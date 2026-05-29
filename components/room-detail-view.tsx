"use client"

import { useState } from "react"
import {
  CalendarDaysIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  ClipboardListIcon,
  MessageSquareIcon,
  SendIcon,
  UsersIcon,
  FileAudioIcon,
  ArrowLeftIcon,
  Loader2Icon,
} from "lucide-react"
import Link from "next/link"

import type { RoomDetail, RoomMeetingSummary, RoomTask, RoomParticipant, RoomArtifact } from "@/lib/rooms"
import type { SupportedLocale } from "@/lib/i18n/locales"

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function StatCard({ label, value, icon: Icon }: { label: string; value: number; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="grid size-10 place-items-center rounded-md bg-[var(--primary)]/10 text-[var(--primary)]">
        <Icon className="size-5" />
      </div>
      <div>
        <div className="text-2xl font-bold text-[var(--text-primary)]">{value}</div>
        <div className="text-xs text-[var(--text-muted)]">{label}</div>
      </div>
    </div>
  )
}

function MeetingCard({ meeting, locale }: { meeting: RoomMeetingSummary; locale: string }) {
  const statusColors: Record<string, string> = {
    completed: "bg-emerald-500/15 text-emerald-600",
    error: "bg-red-500/15 text-red-600",
  }
  const statusClass = statusColors[meeting.status] ?? "bg-amber-500/15 text-amber-600"

  return (
    <Link
      href={`/${locale}`}
      className="block rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:border-[var(--primary)]/30 hover:bg-[var(--surface-hover)]"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="font-medium text-[var(--text-primary)]">{meeting.title}</h3>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusClass}`}>
          {meeting.status}
        </span>
      </div>
      <p className="mb-3 line-clamp-2 text-sm text-[var(--text-muted)]">
        {meeting.overview || "No summary available yet."}
      </p>
      <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
        <span className="flex items-center gap-1">
          <CalendarDaysIcon className="size-3" />
          {formatDate(meeting.startedAt)}
        </span>
        <span className="flex items-center gap-1">
          <UsersIcon className="size-3" />
          {meeting.participants}
        </span>
        {meeting.openTasks > 0 && (
          <span className="flex items-center gap-1 text-amber-600">
            <ClipboardListIcon className="size-3" />
            {meeting.openTasks} open
          </span>
        )}
      </div>
    </Link>
  )
}

function TaskItem({ task }: { task: RoomTask }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <CircleDotIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-[var(--text-primary)]">{task.title}</div>
        <div className="mt-1 flex gap-3 text-xs text-[var(--text-muted)]">
          {task.owner && <span>→ {task.owner}</span>}
          <span>from {task.meetingTitle}</span>
          {task.dueDate && <span className="text-amber-600">due {task.dueDate}</span>}
        </div>
      </div>
    </div>
  )
}

function ParticipantRow({ participant }: { participant: RoomParticipant }) {
  const initials = participant.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)

  return (
    <div className="flex items-center gap-3 py-2">
      <div className="grid size-8 place-items-center rounded-full bg-[var(--primary)]/10 text-xs font-semibold text-[var(--primary)]">
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-[var(--text-primary)]">{participant.name}</div>
        {participant.email && (
          <div className="truncate text-xs text-[var(--text-muted)]">{participant.email}</div>
        )}
      </div>
      <div className="text-xs text-[var(--text-muted)]">
        {participant.meetingCount} meeting{participant.meetingCount !== 1 ? "s" : ""}
      </div>
    </div>
  )
}

function ArtifactRow({ artifact }: { artifact: RoomArtifact }) {
  const icons: Record<string, React.ComponentType<{ className?: string }>> = {
    recording: FileAudioIcon,
    transcript: ClipboardListIcon,
    smart_notes: MessageSquareIcon,
  }
  const Icon = icons[artifact.artifactType] ?? FileAudioIcon

  return (
    <div className="flex items-center gap-3 py-2">
      <Icon className="size-4 text-[var(--text-muted)]" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-[var(--text-primary)]">{artifact.artifactName}</div>
        <div className="text-xs text-[var(--text-muted)]">{artifact.meetingTitle}</div>
      </div>
    </div>
  )
}

function AskRoom({ roomId }: { roomId: string }) {
  const [question, setQuestion] = useState("")
  const [answer, setAnswer] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleAsk() {
    if (!question.trim() || loading) return
    setLoading(true)
    setAnswer(null)

    try {
      const res = await fetch(`/api/rooms/${roomId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      })
      const data = await res.json()
      setAnswer(data.answer ?? data.text ?? "No answer available.")
    } catch {
      setAnswer("Failed to get an answer. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
        <MessageSquareIcon className="size-4 text-[var(--primary)]" />
        Ask this room
      </h2>
      <div className="flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAsk()}
          placeholder="Ask a question about this room's meetings..."
          className="flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:outline-none"
        />
        <button
          onClick={handleAsk}
          disabled={loading || !question.trim()}
          className="grid size-9 place-items-center rounded-md bg-[var(--primary)] text-white disabled:opacity-50"
        >
          {loading ? <Loader2Icon className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
        </button>
      </div>
      {answer && (
        <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-subtle)] p-3 text-sm text-[var(--text-primary)]">
          {answer}
        </div>
      )}
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-8 text-center text-sm text-[var(--text-muted)]">{message}</div>
  )
}

export function RoomDetailView({
  detail,
  locale,
}: {
  detail: RoomDetail
  locale: SupportedLocale
}) {
  const { room, stats, meetings, openTasks, participants, artifacts } = detail

  return (
    <main className="min-h-screen bg-[var(--app-bg)] text-[var(--text-primary)]">
      {/* Header */}
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <Link
            href={`/${locale}`}
            className="mb-4 inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--primary)]"
          >
            <ArrowLeftIcon className="size-3.5" />
            Back to MeetSum
          </Link>

          <div className="flex items-start gap-4">
            <div
              className="mt-1 size-4 shrink-0 rounded-full"
              style={{ backgroundColor: room.color ?? "var(--primary)" }}
            />
            <div>
              <h1 className="text-2xl font-bold">{room.name}</h1>
              {room.description && (
                <p className="mt-1 text-sm text-[var(--text-muted)]">{room.description}</p>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Stats */}
      <div className="mx-auto max-w-6xl px-6 py-6">
        <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Meetings" value={stats.meetings} icon={CalendarDaysIcon} />
          <StatCard label="Completed" value={stats.completedMeetings} icon={CheckCircle2Icon} />
          <StatCard label="Open Tasks" value={stats.openTasks} icon={ClipboardListIcon} />
          <StatCard label="Participants" value={stats.participants} icon={UsersIcon} />
          <StatCard label="Artifacts" value={stats.artifacts} icon={FileAudioIcon} />
        </div>

        {/* Ask */}
        <div className="mb-8">
          <AskRoom roomId={room.id} />
        </div>

        {/* Content Grid */}
        <div className="grid gap-8 lg:grid-cols-3">
          {/* Meetings — 2 cols */}
          <div className="lg:col-span-2">
            <h2 className="mb-4 text-lg font-semibold">Meetings</h2>
            {meetings.length > 0 ? (
              <div className="grid gap-3">
                {meetings
                  .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
                  .map((m) => (
                    <MeetingCard key={m.id} meeting={m} locale={locale} />
                  ))}
              </div>
            ) : (
              <EmptyState message="No meetings in this room yet." />
            )}

            {/* Open Tasks */}
            {openTasks.length > 0 && (
              <div className="mt-8">
                <h2 className="mb-4 text-lg font-semibold">
                  Open Tasks
                  <span className="ml-2 text-sm font-normal text-[var(--text-muted)]">
                    ({openTasks.length})
                  </span>
                </h2>
                <div className="grid gap-2">
                  {openTasks.map((task, i) => (
                    <TaskItem key={`${task.meetingId}-${i}`} task={task} />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right rail */}
          <div className="space-y-6">
            {/* Participants */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <UsersIcon className="size-4 text-[var(--primary)]" />
                Participants
              </h2>
              {participants.length > 0 ? (
                <div className="divide-y divide-[var(--border)]">
                  {participants.map((p) => (
                    <ParticipantRow key={p.email ?? p.name} participant={p} />
                  ))}
                </div>
              ) : (
                <EmptyState message="No participants recorded." />
              )}
            </div>

            {/* Artifacts */}
            {artifacts.length > 0 && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <FileAudioIcon className="size-4 text-[var(--primary)]" />
                  Artifacts
                </h2>
                <div className="divide-y divide-[var(--border)]">
                  {artifacts.map((a) => (
                    <ArtifactRow key={a.id} artifact={a} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
