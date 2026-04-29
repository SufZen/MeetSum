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

  if (!values.length) return 0.92
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
  onExportRealizeOS,
}: {
  meeting: MeetingRecord | null
  jobs: JobRecord[]
  exporting?: boolean
  onExportRealizeOS: () => void
}) {
  const confidence = computeConfidence(meeting)
  const percent = Math.round(confidence * 100)
  const tags = meeting?.tags?.length
    ? meeting.tags
    : ["acquisition", "finance", "review", "real-estate", "english", "mixed"]

  return (
    <aside className="grid content-start gap-3 bg-[var(--rail)] p-3 lg:border-l">
      <PipelineTimeline meeting={meeting} jobs={jobs} />

      <section className="rounded-md border bg-white p-4">
        <h3 className="mb-4 text-sm font-semibold">AI Confidence</h3>
        <div className="flex items-center gap-4">
          <div
            className="grid size-16 place-items-center rounded-full border-[5px] border-emerald-500 text-lg font-semibold"
            aria-label={`AI confidence ${percent}%`}
          >
            {percent}%
          </div>
          <div>
            <div className="font-medium text-emerald-700">
              {percent >= 80 ? "High" : percent >= 60 ? "Medium" : "Low"}
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-600">
              Good audio quality<br />
              Strong transcript match
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" className="mt-2 h-8 px-0 text-teal-700">
          Details
        </Button>
      </section>

      <section className="rounded-md border bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Tags</h3>
          <Button variant="ghost" size="sm" className="h-7 text-teal-700">
            Edit
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {tags.slice(0, 8).map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className={tagClass(tag)}
            >
              {tag}
            </Badge>
          ))}
        </div>
      </section>

      <section className="rounded-md border bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold">Exports & Integrations</h3>
        <div className="grid grid-cols-5 gap-2">
          {[
            [FileTextIcon, "PDF"],
            [NotepadTextIcon, "DOCX"],
            [FileTextIcon, "Notion"],
            [NotepadTextIcon, "RealizeOS"],
          ].map(([Icon, label]) => {
            const TypedIcon = Icon as typeof FileTextIcon

            return (
              <Button
                key={label as string}
                variant="outline"
                size="icon"
                className="size-9 rounded-md"
                onClick={label === "RealizeOS" ? onExportRealizeOS : undefined}
                disabled={label === "RealizeOS" ? !meeting || exporting : false}
                title={label as string}
              >
                <TypedIcon aria-hidden="true" className="size-4" />
              </Button>
            )
          })}
          <Button variant="outline" size="icon" className="size-9 rounded-md">
            <MoreHorizontalIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>
        <div className="mt-2 grid grid-cols-5 gap-2 text-center text-[11px] text-slate-500">
          <span>PDF</span>
          <span>DOCX</span>
          <span>Notion</span>
          <span>RealizeOS</span>
          <span />
        </div>
      </section>

      <GoogleContextCard meeting={meeting} />
    </aside>
  )
}
