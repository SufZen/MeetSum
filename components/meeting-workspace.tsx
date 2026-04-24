import { FileAudioIcon, FileTextIcon, ListTodoIcon } from "lucide-react"

import { ActionItemList } from "@/components/action-item-list"
import { AskMeetingPanel } from "@/components/ask-meeting-panel"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TranscriptTimeline } from "@/components/transcript-timeline"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { ActionItem, MeetingRecord } from "@/lib/meetings/repository"

export function MeetingWorkspace({
  dictionary,
  meeting,
  question,
  answer,
  asking,
  onQuestionChange,
  onAsk,
  onToggleActionItem,
}: {
  dictionary: Dictionary
  meeting: MeetingRecord | null
  question: string
  answer?: string
  asking?: boolean
  onQuestionChange: (value: string) => void
  onAsk: () => void
  onToggleActionItem: (item: ActionItem) => void
}) {
  if (!meeting) {
    return (
      <div className="flex min-h-[520px] flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-card/50 p-8 text-center">
        <FileAudioIcon aria-hidden="true" className="size-10 text-muted-foreground" />
        <h2 className="text-xl font-semibold">{dictionary.noMeetingsTitle}</h2>
        <p className="max-w-sm text-sm leading-6 text-muted-foreground">
          {dictionary.noMeetingsDescription}
        </p>
      </div>
    )
  }

  return (
    <div className="grid min-w-0 gap-4">
      <header className="grid gap-3 rounded-md border bg-card p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="rounded-sm">
                {dictionary.selectedMeeting}
              </Badge>
              <Badge variant="secondary" className="rounded-sm">
                {meeting.source.replaceAll("_", " ")}
              </Badge>
            </div>
            <h2 className="mt-2 break-words text-2xl font-semibold tracking-tight">
              {meeting.title}
            </h2>
            <p className="mt-1 break-words text-sm text-muted-foreground">
              {meeting.participants.length
                ? meeting.participants.join(", ")
                : "No participants captured yet"}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-md border bg-muted/40 p-2">
              <div className="font-mono text-base font-semibold">
                {meeting.transcript?.length ?? 0}
              </div>
              <div className="text-muted-foreground">segments</div>
            </div>
            <div className="rounded-md border bg-muted/40 p-2">
              <div className="font-mono text-base font-semibold">
                {meeting.summary?.actionItems.length ?? 0}
              </div>
              <div className="text-muted-foreground">tasks</div>
            </div>
            <div className="rounded-md border bg-muted/40 p-2">
              <div className="font-mono text-base font-semibold">
                {meeting.language.toUpperCase()}
              </div>
              <div className="text-muted-foreground">{dictionary.language}</div>
            </div>
          </div>
        </div>
      </header>

      <Tabs defaultValue="summary" className="min-w-0">
        <TabsList className="grid min-h-10 w-full grid-cols-3 md:w-fit md:grid-cols-6">
          <TabsTrigger value="summary">{dictionary.summary}</TabsTrigger>
          <TabsTrigger value="transcript">{dictionary.transcript}</TabsTrigger>
          <TabsTrigger value="ask">{dictionary.ask}</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="prep">Prep</TabsTrigger>
          <TabsTrigger value="followup">{dictionary.followUp}</TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="mt-4 grid gap-4">
          <section className="rounded-md border bg-card p-4">
            <div className="mb-2 flex items-center gap-2">
              <FileTextIcon aria-hidden="true" className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">{dictionary.overview}</h3>
            </div>
            <p className="leading-7 text-muted-foreground">
              {meeting.summary?.overview ?? "Summary will appear after intelligence runs."}
            </p>
          </section>
          <section className="rounded-md border bg-card p-4">
            <h3 className="mb-3 text-sm font-semibold">{dictionary.decisions}</h3>
            <div className="grid gap-2">
              {(meeting.summary?.decisions.length
                ? meeting.summary.decisions
                : ["No decisions extracted yet."]).map((decision) => (
                <div key={decision} className="rounded-md bg-muted/60 p-3 text-sm">
                  {decision}
                </div>
              ))}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="transcript" className="mt-4">
          <TranscriptTimeline segments={meeting.transcript} />
        </TabsContent>

        <TabsContent value="ask" className="mt-4">
          <AskMeetingPanel
            dictionary={dictionary}
            question={question}
            answer={answer}
            asking={asking}
            disabled={!meeting}
            onQuestionChange={onQuestionChange}
            onAsk={onAsk}
          />
        </TabsContent>

        <TabsContent value="tasks" className="mt-4">
          <section className="rounded-md border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <ListTodoIcon aria-hidden="true" className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">{dictionary.actionItems}</h3>
            </div>
            <ActionItemList
              items={meeting.summary?.actionItems}
              unassigned={dictionary.unassigned}
              onToggle={onToggleActionItem}
            />
          </section>
        </TabsContent>

        <TabsContent value="prep" className="mt-4">
          <section className="rounded-md border bg-card p-4 text-sm leading-6 text-muted-foreground">
            Gmail-aware prep, linked Drive docs, and previous context packets will
            land here after the Calendar/Drive spine is running.
          </section>
        </TabsContent>

        <TabsContent value="followup" className="mt-4">
          <section className="rounded-md border bg-card p-4 text-sm leading-6 text-muted-foreground">
            {meeting.intelligence?.followUpDraft ??
              "Follow-up draft will appear after structured intelligence runs."}
          </section>
        </TabsContent>
      </Tabs>
    </div>
  )
}
