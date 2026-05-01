import { FileTextIcon, MoreHorizontalIcon, NotepadTextIcon } from "lucide-react"

import { GoogleContextCard } from "@/components/google-context-card"
import { PipelineTimeline } from "@/components/pipeline-timeline"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { JobRecord, MeetingRecord } from "@/lib/meetings/repository"

function computeConfidence(meeting: MeetingRecord | null) {
  const transcript = meeting?.transcript ?? []
  const actionItems = meeting?.summary?.actionItems ?? []
  const values = [
    ...transcript.map((segment) => segment.confidence).filter(Boolean),
    ...actionItems.map((item) => item.confidence).filter(Boolean),
  ] as number[]

  if (!values.length) return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function tagClass(tag: string) {
  if (/(urgent|follow|review|action|task)/i.test(tag)) {
    return "rounded-sm bg-[var(--tag-action)] text-[var(--tag-action-fg)]"
  }
  if (/(ai|mixed|hebrew|english|portuguese|spanish|italian)/i.test(tag)) {
    return "rounded-sm bg-[var(--tag-ai)] text-[var(--tag-ai-fg)]"
  }
  if (/(technical|product|mcp|gemini|gemma|realizeos)/i.test(tag)) {
    return "rounded-sm bg-[var(--tag-technical)] text-[var(--tag-technical-fg)]"
  }

  return "rounded-sm bg-[var(--tag-business)] text-[var(--tag-business-fg)]"
}

export function MeetingRightRail({
  meeting,
  jobs,
  exporting,
  onEditTags,
  onExportMarkdown,
  onExportPdf,
  onExportRealizeOS,
}: {
  meeting: MeetingRecord | null
  jobs: JobRecord[]
  exporting?: boolean
  onEditTags: () => void
  onExportMarkdown: () => void
  onExportPdf: () => void
  onExportRealizeOS: () => void
}) {
  const confidence = computeConfidence(meeting)
  const percent = confidence ? Math.round(confidence * 100) : undefined
  const tags = meeting?.tags ?? []

  return (
    <aside className="ms-scrollbar grid min-h-0 content-start gap-3 overflow-y-auto bg-[var(--rail)] p-3 lg:h-full lg:border-l lg:border-[var(--divider)]">
      <PipelineTimeline meeting={meeting} jobs={jobs} />

      <section className="ms-card p-4">
        <h3 className="mb-4 text-sm font-semibold">AI Confidence</h3>
        {percent ? (
          <div className="flex items-center gap-4">
            <div
              className="grid size-16 place-items-center rounded-full border-[5px] border-emerald-500 text-lg font-semibold"
              aria-label={`AI confidence ${percent}%`}
            >
              {percent}%
            </div>
            <div>
              <div className="font-medium text-[var(--status-success)]">
                {percent >= 80 ? "High" : percent >= 60 ? "Medium" : "Low"}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Based on transcript and task confidence
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-[var(--divider)] bg-[var(--surface-subtle)] p-3 text-sm text-muted-foreground">
            Confidence appears after transcription or structured intelligence.
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-8 px-0 text-[var(--primary)]"
          disabled
          title={
            percent
              ? "Detailed quality review is coming in the next slice"
              : "Run intelligence first"
          }
        >
          Details
        </Button>
      </section>

      <section className="ms-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Tags</h3>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[var(--primary)]"
            onClick={onEditTags}
            disabled={!meeting}
          >
            Edit
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {tags.length ? tags.slice(0, 8).map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className={tagClass(tag)}
            >
              {tag}
            </Badge>
          )) : (
            <span className="text-sm text-muted-foreground">
              No tags extracted yet.
            </span>
          )}
        </div>
      </section>

      <section className="ms-card p-4">
        <h3 className="mb-3 text-sm font-semibold">Exports & Integrations</h3>
        <div className="grid grid-cols-5 gap-2">
          {[
            {
              Icon: FileTextIcon,
              label: "PDF",
              onClick: onExportPdf,
              enabled: Boolean(meeting),
            },
            {
              Icon: NotepadTextIcon,
              label: "MD",
              onClick: onExportMarkdown,
              enabled: Boolean(meeting),
            },
            {
              Icon: FileTextIcon,
              label: "Notion",
              onClick: undefined,
              enabled: false,
            },
            {
              Icon: NotepadTextIcon,
              label: "RealizeOS",
              onClick: onExportRealizeOS,
              enabled: Boolean(meeting) && !exporting,
            },
          ].map(({ Icon: TypedIcon, label, onClick, enabled }) => (
            <Button
              key={label}
              variant="outline"
              size="icon"
              className="size-9 rounded-md"
              onClick={onClick}
              disabled={!enabled}
              title={enabled ? label : `${label} is not available yet`}
            >
              <TypedIcon aria-hidden="true" className="size-4" />
            </Button>
          ))}
          <Button variant="outline" size="icon" className="size-9 rounded-md" disabled title="More exports coming next">
            <MoreHorizontalIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>
        <div className="mt-2 grid grid-cols-5 gap-2 text-center text-[11px] text-muted-foreground">
          <span>PDF</span>
          <span>MD</span>
          <span>Notion</span>
          <span>RealizeOS</span>
          <span />
        </div>
      </section>

      <GoogleContextCard meeting={meeting} />
    </aside>
  )
}
