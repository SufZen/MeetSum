import {
  CalendarDaysIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  CloudUploadIcon,
  FileAudioIcon,
  FileTextIcon,
  NotebookTabsIcon,
  RadioTowerIcon,
  VideoIcon,
  XCircleIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import type {
  CaptureReadiness,
  CaptureReadinessAction,
  CaptureReadinessCheck,
} from "@/lib/meetings/capture-readiness"

const stateIcons = {
  ready: CheckCircle2Icon,
  pending: CircleDashedIcon,
  missing: XCircleIcon,
} as const

const stateStyles = {
  ready: {
    icon: "size-4 shrink-0 text-[var(--status-success)]",
    text: "text-sm font-medium text-foreground",
  },
  pending: {
    icon: "size-4 shrink-0 text-muted-foreground",
    text: "text-sm text-muted-foreground",
  },
  missing: {
    icon: "size-4 shrink-0 text-[var(--status-warning)]",
    text: "text-sm text-[var(--status-warning)]",
  },
} as const

const checkKeyIcons: Record<CaptureReadinessCheck["key"], typeof FileAudioIcon> = {
  calendar: CalendarDaysIcon,
  meet_record: RadioTowerIcon,
  recording: VideoIcon,
  transcript: FileTextIcon,
  smart_notes: NotebookTabsIcon,
  media: CloudUploadIcon,
}

function CheckItem({ check }: { check: CaptureReadinessCheck }) {
  const StateIcon = stateIcons[check.state]
  const styles = stateStyles[check.state]
  const KeyIcon = checkKeyIcons[check.key]

  return (
    <div className="flex items-center gap-3 rounded-md border border-[var(--divider)] bg-[var(--surface)] px-3 py-2">
      <StateIcon aria-hidden="true" className={styles.icon} />
      <KeyIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className={styles.text}>{check.label}</span>
    </div>
  )
}

const actionLabels: Record<CaptureReadinessAction, string> = {
  none: "Processed",
  process: "Process meeting",
  sync_artifacts: "Sync Meet artifacts",
  upload: "Upload recording",
}

const actionIcons: Record<CaptureReadinessAction, typeof FileAudioIcon> = {
  none: CheckCircle2Icon,
  process: FileAudioIcon,
  sync_artifacts: RadioTowerIcon,
  upload: CloudUploadIcon,
}

export function MeetingEmptyState({
  readiness,
  onProcess,
  onSyncArtifacts,
  onUpload,
}: {
  readiness: CaptureReadiness
  onProcess?: () => void
  onSyncArtifacts?: () => void
  onUpload?: () => void
}) {
  const ActionIcon = actionIcons[readiness.primaryAction]
  const readyCount = readiness.checks.filter((c) => c.state === "ready").length
  const totalCount = readiness.checks.length

  function handleAction() {
    switch (readiness.primaryAction) {
      case "process":
        onProcess?.()
        break
      case "sync_artifacts":
        onSyncArtifacts?.()
        break
      case "upload":
        onUpload?.()
        break
      default:
        break
    }
  }

  return (
    <div className="grid gap-4 rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-5">
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-[var(--selected)] text-[var(--primary)]">
          <ActionIcon aria-hidden="true" className="size-5" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            {readiness.title}
          </h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {readiness.description}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-md bg-[var(--surface)] px-3 py-2">
        <span className="text-xs font-semibold text-foreground">
          {readyCount}/{totalCount} checks ready
        </span>
        <div className="h-1.5 flex-1 rounded-full bg-[var(--divider)]">
          <div
            className="h-full rounded-full bg-[var(--primary)] transition-all"
            style={{ width: `${(readyCount / totalCount) * 100}%` }}
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        {readiness.checks.map((check) => (
          <CheckItem key={check.key} check={check} />
        ))}
      </div>

      {readiness.primaryAction !== "none" ? (
        <Button className="h-10 w-full" onClick={handleAction}>
          <ActionIcon data-icon="inline-start" />
          {actionLabels[readiness.primaryAction]}
        </Button>
      ) : null}
    </div>
  )
}
