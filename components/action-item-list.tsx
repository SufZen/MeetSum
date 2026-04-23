import { Badge } from "@/components/ui/badge"
import type { ActionItem } from "@/lib/meetings/repository"

export function ActionItemList({
  items = [],
  unassigned,
}: {
  items?: ActionItem[]
  unassigned: string
}) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <div
          key={item.id}
          className="grid gap-2 rounded-md border bg-card p-3 text-sm"
        >
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 leading-5">{item.title}</span>
            <Badge variant="outline" className="shrink-0 rounded-sm">
              {item.owner ?? unassigned}
            </Badge>
          </div>
          {(item.priority || item.confidence) && (
            <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
              {item.priority && <span>{item.priority}</span>}
              {item.confidence && <span>{Math.round(item.confidence * 100)}%</span>}
              {item.sourceStartMs !== undefined && (
                <span>{Math.floor(item.sourceStartMs / 1000)}s</span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
