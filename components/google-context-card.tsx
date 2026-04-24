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
    <section className="rounded-md border bg-white p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Google Context</h3>
        <Button variant="ghost" size="sm" className="h-7 text-teal-700">
          View all
        </Button>
      </div>
      <div className="grid gap-3">
        {items.map((item) => {
          const Icon = item.icon

          return (
            <div key={item.label} className="grid grid-cols-[22px_minmax(0,1fr)] gap-3">
              <Icon aria-hidden="true" className="mt-0.5 size-5 text-teal-700" />
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-950">{item.label}</div>
                <div className="truncate text-xs text-slate-600">{item.value}</div>
              </div>
            </div>
          )
        })}
        {!meeting && (
          <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-xs text-slate-500">
            <FileIcon aria-hidden="true" className="size-4" />
            Select a meeting to see linked Workspace context.
          </div>
        )}
      </div>
    </section>
  )
}
