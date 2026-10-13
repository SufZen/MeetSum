"use client"

import { CalendarIcon, PencilIcon } from "lucide-react"

import { PlayerCitation } from "@/components/player/player-citation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { ActionItem } from "@/lib/meetings/repository"

export function ActionItemList({
  items = [],
  unassigned,
  onToggle,
  dictionary,
}: {
  items?: ActionItem[]
  unassigned: string
  onToggle?: (item: ActionItem) => void
  /** Enables the "▶ 12:34" source chip (rendered only when it resolves). */
  dictionary?: Dictionary
}) {
  return (
    <div className="flex flex-col gap-2">
      {items.length ? items.map((item) => (
        <div
          key={item.id}
          className="grid gap-2 rounded-lg border border-line bg-surface p-3 text-sm"
        >
          <div className="grid gap-3 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-start">
            <Checkbox
              checked={item.status === "done"}
              onCheckedChange={() => onToggle?.(item)}
              className="mt-0.5"
              disabled={!onToggle}
            />
            <div className="min-w-0">
              <div className="leading-6 text-foreground">{item.title}</div>
              {item.sourceQuote && (
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {item.sourceQuote}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {dictionary && item.sourceStartMs !== undefined ? (
                <PlayerCitation
                  startMs={item.sourceStartMs}
                  source="action_item"
                  dictionary={dictionary}
                />
              ) : null}
              <Badge variant="outline" className="rounded-md">
                {item.owner ? <bdi>{item.owner}</bdi> : unassigned}
              </Badge>
              <Button
                size="icon-sm"
                variant="ghost"
                className="size-7 rounded-md"
                disabled
                title="Inline editing is planned for the next task editor pass"
              >
                <PencilIcon aria-hidden="true" className="size-3.5" />
                <span className="sr-only">Edit task</span>
              </Button>
            </div>
          </div>
          {(item.priority || item.confidence) && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {item.priority && <span className="capitalize">{item.priority}</span>}
              {item.dueDate && (
                <span className="inline-flex items-center gap-1">
                  <CalendarIcon aria-hidden="true" className="size-3.5" />
                  {item.dueDate}
                </span>
              )}
              {item.confidence && <span>{Math.round(item.confidence * 100)}% confidence</span>}
            </div>
          )}
        </div>
      )) : (
        <div className="rounded-lg border border-dashed border-line bg-surface-2 p-4 text-sm text-muted-foreground">
          No smart tasks extracted yet.
        </div>
      )}
    </div>
  )
}
