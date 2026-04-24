import { FileAudioIcon, ListTodoIcon } from "lucide-react"

import { ActionItemList } from "@/components/action-item-list"
import { AskMeetingPanel } from "@/components/ask-meeting-panel"
import { MeetingHeader } from "@/components/meeting-header"
import { MeetingSummaryView } from "@/components/meeting-summary-view"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TranscriptTimeline } from "@/components/transcript-timeline"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
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
  locale,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
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
    <div className="min-w-0 bg-white">
      <MeetingHeader meeting={meeting} locale={locale} />

      <Tabs defaultValue="summary" className="min-w-0">
        <TabsList className="mx-7 mt-5 grid min-h-10 w-[min(640px,calc(100%-3.5rem))] grid-cols-3 bg-transparent p-0 md:grid-cols-6">
          <TabsTrigger value="summary">{dictionary.summary}</TabsTrigger>
          <TabsTrigger value="transcript">{dictionary.transcript}</TabsTrigger>
          <TabsTrigger value="ask">{dictionary.ask}</TabsTrigger>
          <TabsTrigger value="tasks">
            Tasks
            <span className="ms-1 rounded-full bg-slate-100 px-2 text-xs">
              {meeting.summary?.actionItems.length ?? 0}
            </span>
          </TabsTrigger>
          <TabsTrigger value="prep">Prep</TabsTrigger>
          <TabsTrigger value="followup">{dictionary.followUp}</TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="mt-0">
          <MeetingSummaryView
            dictionary={dictionary}
            meeting={meeting}
            onToggleActionItem={onToggleActionItem}
          />
        </TabsContent>

        <TabsContent value="transcript" className="mt-0 px-7 py-7">
          <TranscriptTimeline segments={meeting.transcript} />
        </TabsContent>

        <TabsContent value="ask" className="mt-0 px-7 py-7">
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

        <TabsContent value="tasks" className="mt-0 px-7 py-7">
          <section className="rounded-md border bg-white p-4">
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

        <TabsContent value="prep" className="mt-0 px-7 py-7">
          <section className="rounded-md border bg-white p-4 text-sm leading-6 text-muted-foreground">
            Gmail-aware prep, linked Drive docs, and previous context packets will
            land here after the Calendar/Drive spine is running.
          </section>
        </TabsContent>

        <TabsContent value="followup" className="mt-0 px-7 py-7">
          <section className="rounded-md border bg-white p-4 text-sm leading-6 text-muted-foreground">
            {meeting.intelligence?.followUpDraft ??
              "Follow-up draft will appear after structured intelligence runs."}
          </section>
        </TabsContent>
      </Tabs>
    </div>
  )
}
