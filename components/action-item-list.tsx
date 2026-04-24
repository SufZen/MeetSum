import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { ActionItem } from "@/lib/meetings/repository"

export function ActionItemList({
  items = [],
  unassigned,
  onToggle,
}: {
  items?: ActionItem[]
  unassigned: string
  onToggle?: (item: ActionItem) => void
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
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant="outline" className="rounded-sm">
                {item.owner ?? unassigned}
              </Badge>
              {onToggle && (
                <Button
                  size="sm"
                  variant={item.status === "done" ? "secondary" : "outline"}
                  className="h-7 rounded-sm px-2 text-xs"
                  onClick={() => onToggle(item)}
                >
                  {item.status === "done" ? "Done" : "Open"}
                </Button>
              )}
            </div>
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
