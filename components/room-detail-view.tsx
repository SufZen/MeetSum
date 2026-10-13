"use client"

import {
  CalendarDaysIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  ClockIcon,
  ClipboardListIcon,
  MessageSquareIcon,
  UsersIcon,
  FileAudioIcon,
  ArrowLeftIcon,
} from "lucide-react"
import Link from "next/link"

import { LazyAskPanel } from "@/components/ask/lazy"
import { useDictionary, useI18n } from "@/components/i18n-provider"
import { formatMessage } from "@/lib/i18n/messages"
import { formatDurationLabel } from "@/lib/meetings/duration"
import type { RoomDetail, RoomMeetingSummary, RoomTask, RoomParticipant, RoomArtifact } from "@/lib/rooms"
import type { SupportedLocale } from "@/lib/i18n/locales"

/** Wraps a name or title in Unicode isolates for use inside a message string. */
const isolate = (value: string) => `\u2068${value}\u2069`

function StatCard({ label, value, icon: Icon }: { label: string; value: number; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="grid size-10 place-items-center rounded-md bg-brand/10 text-brand-text">
        <Icon className="size-5" />
      </div>
      <div>
        <div className="text-2xl font-bold text-fg">{value}</div>
        <div className="text-xs text-fg-3">{label}</div>
      </div>
    </div>
  )
}

function MeetingCard({ meeting, locale }: { meeting: RoomMeetingSummary; locale: string }) {
  const { t, plural, fmt, text } = useI18n()
  const statusClass =
    meeting.status === "completed"
      ? "bg-ok-soft text-ok-text"
      : meeting.status === "failed"
        ? "bg-danger-soft text-danger-text"
        : "bg-warn-soft text-warn-text"
  const statusLabel =
    meeting.status === "completed"
      ? t("opsMeetingStatusCompleted")
      : meeting.status === "failed"
        ? t("opsMeetingStatusFailed")
        : t("opsMeetingStatusProcessing")

  return (
    <Link
      href={`/${locale}?meeting=${encodeURIComponent(meeting.id)}`}
      className="block rounded-lg border border-line bg-surface p-4 transition-colors hover:border-brand/30 hover:bg-surface-3"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="font-medium text-fg">
          <bdi>{text(meeting.title)}</bdi>
        </h3>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusClass}`}>
          {statusLabel}
        </span>
      </div>
      <p dir="auto" className="mb-3 line-clamp-2 text-sm text-fg-3">
        {meeting.overview ? text(meeting.overview) : t("opsRoomNoSummary")}
      </p>
      <div className="flex items-center gap-4 text-xs text-fg-3">
        <span className="flex items-center gap-1">
          <CalendarDaysIcon className="size-3" />
          {fmt.date(meeting.startedAt, "dateTime")}
        </span>
        <span className="flex items-center gap-1 [unicode-bidi:isolate]">
          <ClockIcon className="size-3" />
          {formatDurationLabel(meeting.durationMs, locale)}
        </span>
        <span className="flex items-center gap-1">
          <UsersIcon className="size-3" />
          {meeting.participants}
        </span>
        {meeting.openTasks > 0 && (
          <span className="flex items-center gap-1 text-warn-text">
            <ClipboardListIcon className="size-3" />
            {plural("opsRoomOpenTasks", meeting.openTasks)}
          </span>
        )}
      </div>
    </Link>
  )
}

function TaskItem({ task }: { task: RoomTask }) {
  const { t, fmt, text } = useI18n()

  return (
    <div className="flex items-start gap-3 rounded-md border border-line bg-surface px-4 py-3">
      <CircleDotIcon className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-fg">
          <bdi>{text(task.title)}</bdi>
        </div>
        <div className="mt-1 flex gap-3 text-xs text-fg-3">
          {task.owner && <span>{t("opsRoomTaskOwner", { name: isolate(task.owner) })}</span>}
          <span>{t("opsRoomTaskFrom", { meeting: isolate(task.meetingTitle) })}</span>
          {task.dueDate && (
            <span className="text-warn-text">
              {t("opsRoomTaskDue", { date: isolate(fmt.date(task.dueDate, "date") || task.dueDate) })}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function ParticipantRow({ participant }: { participant: RoomParticipant }) {
  const { plural } = useI18n()
  const initials = participant.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)

  return (
    <div className="flex items-center gap-3 py-2">
      <div className="grid size-8 place-items-center rounded-full bg-brand/10 text-xs font-semibold text-brand-text">
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg">
          <bdi>{participant.name}</bdi>
        </div>
        {participant.email && (
          <div className="truncate text-xs text-fg-3">
            <bdi>{participant.email}</bdi>
          </div>
        )}
      </div>
      <div className="text-xs text-fg-3">
        {plural("coreMeetingsCount", participant.meetingCount)}
      </div>
    </div>
  )
}

function ArtifactRow({ artifact }: { artifact: RoomArtifact }) {
  const { text } = useI18n()
  const icons: Record<string, React.ComponentType<{ className?: string }>> = {
    recording: FileAudioIcon,
    transcript: ClipboardListIcon,
    smart_notes: MessageSquareIcon,
  }
  const Icon = icons[artifact.artifactType] ?? FileAudioIcon

  return (
    <div className="flex items-center gap-3 py-2">
      <Icon className="size-4 text-fg-3" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-fg">
          <bdi>{artifact.artifactName}</bdi>
        </div>
        <div className="text-xs text-fg-3">
          <bdi>{text(artifact.meetingTitle)}</bdi>
        </div>
      </div>
    </div>
  )
}

/** M6: room-scope AskMeetSum (streamed, cited answers), code split. */
function AskRoom({ roomId, roomName, locale }: { roomId: string; roomName: string; locale: SupportedLocale }) {
  const dictionary = useDictionary()

  return (
    <LazyAskPanel
      locale={locale}
      dictionary={dictionary}
      scope={{ kind: "room", roomId }}
      scopeLabel={roomName ? formatMessage(dictionary.askScopeRoom, { name: roomName }) : dictionary.askScopeRoomUnnamed}
    />
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-8 text-center text-sm text-fg-3">{message}</div>
  )
}

export function RoomDetailView({
  detail,
  locale,
}: {
  detail: RoomDetail
  locale: SupportedLocale
}) {
  const { t } = useI18n()
  const { room, stats, meetings, openTasks, participants, artifacts } = detail

  return (
    <main className="min-h-screen bg-canvas text-fg">
      {/* Header */}
      <header className="border-b border-line bg-surface">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <Link
            href={`/${locale}`}
            className="mb-4 inline-flex items-center gap-1.5 text-sm text-fg-3 hover:text-brand-text"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-3.5" data-directional="" />
            {t("opsRoomBack")}
          </Link>

          <div className="flex items-start gap-4">
            <div
              className="mt-1 size-4 shrink-0 rounded-full"
              style={{ backgroundColor: room.color ?? "var(--brand)" }}
            />
            <div>
              <h1 className="text-2xl font-bold">
                <bdi dir="auto">{room.name}</bdi>
              </h1>
              {room.description && (
                <p dir="auto" className="mt-1 text-sm text-fg-3">
                  {room.description}
                </p>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Stats */}
      <div className="mx-auto max-w-6xl px-6 py-6">
        <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label={t("navMeetings")} value={stats.meetings} icon={CalendarDaysIcon} />
          <StatCard label={t("opsRoomStatCompleted")} value={stats.completedMeetings} icon={CheckCircle2Icon} />
          <StatCard label={t("opsRoomStatOpenTasks")} value={stats.openTasks} icon={ClipboardListIcon} />
          <StatCard label={t("opsRoomStatParticipants")} value={stats.participants} icon={UsersIcon} />
          <StatCard label={t("opsRoomStatArtifacts")} value={stats.artifacts} icon={FileAudioIcon} />
        </div>

        {/* Ask */}
        <div className="mb-8">
          <AskRoom roomId={room.id} roomName={room.name} locale={locale} />
        </div>

        {/* Content Grid */}
        <div className="grid gap-8 lg:grid-cols-3">
          {/* Meetings — 2 cols */}
          <div className="lg:col-span-2">
            <h2 className="mb-4 text-lg font-semibold">{t("navMeetings")}</h2>
            {meetings.length > 0 ? (
              <div className="grid gap-3">
                {meetings
                  .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
                  .map((m) => (
                    <MeetingCard key={m.id} meeting={m} locale={locale} />
                  ))}
              </div>
            ) : (
              <EmptyState message={t("opsRoomNoMeetings")} />
            )}

            {/* Open Tasks */}
            {openTasks.length > 0 && (
              <div className="mt-8">
                <h2 className="mb-4 text-lg font-semibold">
                  {t("opsRoomStatOpenTasks")}
                  <span className="ms-2 text-sm font-normal text-fg-3">
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
            <div className="rounded-lg border border-line bg-surface p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <UsersIcon className="size-4 text-brand-text" />
                {t("opsRoomStatParticipants")}
              </h2>
              {participants.length > 0 ? (
                <div className="divide-y divide-line">
                  {participants.map((p) => (
                    <ParticipantRow key={p.email ?? p.name} participant={p} />
                  ))}
                </div>
              ) : (
                <EmptyState message={t("opsRoomNoParticipants")} />
              )}
            </div>

            {/* Artifacts */}
            {artifacts.length > 0 && (
              <div className="rounded-lg border border-line bg-surface p-4">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <FileAudioIcon className="size-4 text-brand-text" />
                  {t("opsRoomStatArtifacts")}
                </h2>
                <div className="divide-y divide-line">
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
