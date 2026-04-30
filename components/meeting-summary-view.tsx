import { CheckCircle2Icon, CopyIcon, RefreshCwIcon } from "lucide-react"

import { AudioPlaybackBar } from "@/components/audio-playback-bar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { ActionItem, MeetingRecord } from "@/lib/meetings/repository"

function quoteTime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  return `00:${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`
}

function priorityClass(priority?: ActionItem["priority"]) {
  if (priority === "urgent" || priority === "high") {
    return "border-[var(--accent)] bg-[var(--tag-action)] text-[var(--tag-action-fg)]"
  }
  if (priority === "low") {
    return "border-[var(--status-success)] bg-[var(--tag-business)] text-[var(--tag-business-fg)]"
  }
  return "border-[var(--accent)] bg-[var(--tag-action)] text-[var(--tag-action-fg)]"
}

export function MeetingSummaryView({
  dictionary,
  meeting,
  onToggleActionItem,
  onReprocessMeeting,
}: {
  dictionary: Dictionary
  meeting: MeetingRecord
  onToggleActionItem: (item: ActionItem) => void
  onReprocessMeeting: (mode: "full" | "summary" | "tasks" | "transcript-cleanup") => void
}) {
  const actionItems = meeting.summary?.actionItems ?? []
  const quotes = meeting.transcript?.slice(0, 2) ?? []

  return (
    <div className="px-7 py-7">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{dictionary.overview}</h2>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[var(--primary)]"
              onClick={() => onReprocessMeeting("full")}
            >
              <RefreshCwIcon data-icon="inline-start" className="size-4" />
              Reprocess
            </Button>
            <Button variant="ghost" size="sm" className="h-8 text-muted-foreground">
              <CopyIcon data-icon="inline-start" className="size-4" />
              Copy
            </Button>
          </div>
        </div>
        <p className="max-w-3xl text-sm leading-7 text-muted-foreground">
          {meeting.summary?.overview ?? "Summary will appear after intelligence runs."}
        </p>
      </section>

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{dictionary.decisions}</h2>
          <Button variant="ghost" size="sm" className="h-8 text-muted-foreground">
            <CopyIcon data-icon="inline-start" className="size-4" />
            Copy
          </Button>
        </div>
        <div className="grid gap-2">
          {(meeting.summary?.decisions.length
            ? meeting.summary.decisions
            : ["No decisions extracted yet."]).map((decision) => (
            <div key={decision} className="flex items-start gap-3 text-sm text-foreground">
              <CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-500" />
              <span>{decision}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">{dictionary.actionItems}</h2>
        <div className="grid gap-3">
          {actionItems.map((item, index) => (
            <div
              key={item.id}
              className="grid min-h-9 grid-cols-[auto_minmax(0,1fr)] gap-3 text-sm md:grid-cols-[auto_minmax(0,1fr)_150px_90px_92px]"
            >
              <Checkbox
                checked={item.status === "done"}
                onCheckedChange={() => onToggleActionItem(item)}
                className="mt-1"
              />
              <div className="min-w-0 leading-6 text-foreground">{item.title}</div>
              <div className="hidden items-center gap-2 text-muted-foreground md:flex">
                <span className="grid size-6 place-items-center rounded-full bg-rose-200 text-xs font-semibold text-rose-800">
                  {(item.owner ?? "T").slice(0, 1)}
                </span>
                <span className="truncate">{item.owner ?? dictionary.unassigned}</span>
              </div>
              <div className="hidden text-muted-foreground md:block">
                {item.dueDate ?? `May ${index + 1}`}
              </div>
              <div
                className={`hidden h-7 w-fit items-center rounded-full border px-3 text-xs font-medium md:flex ${priorityClass(item.priority)}`}
              >
                {item.priority ?? (index % 2 ? "Medium" : "High")}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Key Quotes</h2>
          <Button variant="ghost" size="sm" className="h-8 text-muted-foreground">
            <CopyIcon data-icon="inline-start" className="size-4" />
            Copy
          </Button>
        </div>
        <div className="grid gap-2">
          {quotes.length ? (
            quotes.map((segment) => (
              <div
                key={segment.id}
                className="grid gap-2 rounded-md border border-[var(--divider)] bg-[var(--surface)] px-3 py-2 text-sm md:grid-cols-[72px_minmax(0,1fr)]"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {quoteTime(segment.startMs)}
                </span>
                <span className="text-muted-foreground">
                  {segment.speaker}: “{segment.text}”
                </span>
              </div>
            ))
          ) : (
            <div className="rounded-md border border-dashed border-[var(--divider)] p-3 text-sm text-muted-foreground">
              Quotes will appear after transcription.
            </div>
          )}
        </div>
      </section>

      <AudioPlaybackBar meeting={meeting} />
    </div>
  )
}
