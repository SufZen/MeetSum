import { Badge } from "@/components/ui/badge"
import type { MeetingStatus } from "@/lib/meetings/state"

const toneByStatus: Partial<Record<MeetingStatus, string>> = {
  completed: "border-emerald-200 bg-emerald-50 text-emerald-700",
  failed: "border-red-200 bg-red-50 text-red-700",
  summarizing: "border-violet-200 bg-violet-50 text-violet-700",
  indexing: "border-blue-200 bg-blue-50 text-blue-700",
  transcribing: "border-amber-200 bg-amber-50 text-amber-800",
}

export function StatusBadge({ status }: { status: MeetingStatus }) {
  return (
    <Badge
      variant="outline"
      className={toneByStatus[status] ?? "border-border bg-muted text-muted-foreground"}
    >
      {status.replaceAll("_", " ")}
    </Badge>
  )
}
