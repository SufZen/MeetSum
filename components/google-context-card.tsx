import { CalendarDaysIcon, FileIcon, FolderIcon, MailIcon, VideoIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { MeetingRecord } from "@/lib/meetings/repository"

export function GoogleContextCard({ meeting }: { meeting: MeetingRecord | null }) {
  const title = meeting?.title ?? "No meeting selected"
  const items = [
    { icon: CalendarDaysIcon, label: "Event", value: title },
    { icon: VideoIcon, label: "Recording", value: meeting?.mediaAssets?.[0]?.filename ?? "Meet recording (Drive)" },
    { icon: MailIcon, label: "Thread", value: `${title} - Notes & Docs` },
    { icon: FolderIcon, label: "Files", value: "5 related files" },
  ]

  return (
    <section className="rounded-md border border-[var(--divider)] bg-[var(--surface)] p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Google Context</h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[var(--primary)]"
          disabled
          title="Full Google context explorer is coming next"
        >
          View all
        </Button>
      </div>
      <div className="grid gap-3">
        {items.map((item) => {
          const Icon = item.icon

          return (
            <div key={item.label} className="grid grid-cols-[22px_minmax(0,1fr)] gap-3">
              <Icon aria-hidden="true" className="mt-0.5 size-5 text-[var(--primary)]" />
              <div className="min-w-0">
                <div className="text-xs font-semibold text-foreground">{item.label}</div>
                <div className="truncate text-xs text-muted-foreground">{item.value}</div>
              </div>
            </div>
          )
        })}
        {!meeting && (
          <div className="flex items-center gap-2 rounded-md border border-dashed border-[var(--divider)] p-3 text-xs text-muted-foreground">
            <FileIcon aria-hidden="true" className="size-4" />
            Select a meeting to see linked Workspace context.
          </div>
        )}
      </div>
    </section>
  )
}
