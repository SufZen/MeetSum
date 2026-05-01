import {
  CalendarSyncIcon,
  FileAudioIcon,
  ListTodoIcon,
  SettingsIcon,
  UploadIcon,
} from "lucide-react"

import { ActionItemList } from "@/components/action-item-list"
import { AskMeetingPanel } from "@/components/ask-meeting-panel"
import { MeetingHeader } from "@/components/meeting-header"
import { MeetingSummaryView } from "@/components/meeting-summary-view"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
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
  onReprocessMeeting,
  onOpenUpload,
  onSyncGoogle,
  onCheckSetup,
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
  onReprocessMeeting: (mode: "full" | "summary" | "tasks" | "transcript-cleanup") => void
  onOpenUpload: () => void
  onSyncGoogle: () => void
  onCheckSetup: () => void
}) {
  if (!meeting) {
    return (
      <div className="flex min-h-[520px] flex-col items-center justify-center gap-3 rounded-md border border-dashed border-[var(--divider)] bg-[var(--surface)]/70 p-8 text-center lg:h-full">
        <FileAudioIcon aria-hidden="true" className="size-10 text-muted-foreground" />
        <h2 className="text-xl font-semibold">{dictionary.noMeetingsTitle}</h2>
        <p className="max-w-sm text-sm leading-6 text-muted-foreground">
          {dictionary.noMeetingsDescription}
        </p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Button onClick={onSyncGoogle}>
            <CalendarSyncIcon data-icon="inline-start" />
            Sync Google Workspace
          </Button>
          <Button variant="outline" onClick={onOpenUpload}>
            <UploadIcon data-icon="inline-start" />
            Upload recording
          </Button>
          <Button variant="ghost" onClick={onCheckSetup}>
            <SettingsIcon data-icon="inline-start" />
            Check setup
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="ms-scrollbar min-h-0 min-w-0 overflow-y-auto bg-[var(--surface)] lg:h-full">
      <MeetingHeader meeting={meeting} locale={locale} />

      <Tabs defaultValue="summary" className="min-w-0">
        <TabsList
          variant="line"
          className="mx-auto mt-4 grid min-h-10 w-[min(720px,calc(100%-2.5rem))] grid-cols-3 border-b border-[var(--divider)] bg-transparent p-0 md:grid-cols-6"
        >
          <TabsTrigger value="summary">{dictionary.summary}</TabsTrigger>
          <TabsTrigger value="transcript">{dictionary.transcript}</TabsTrigger>
          <TabsTrigger value="ask">{dictionary.ask}</TabsTrigger>
          <TabsTrigger value="tasks">
            Tasks
            <span className="ms-1 rounded-full bg-[var(--muted)] px-2 text-xs text-muted-foreground">
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
            onReprocessMeeting={onReprocessMeeting}
          />
        </TabsContent>

        <TabsContent value="transcript" className="mt-0 px-5 py-6 md:px-8">
          <div className="mx-auto max-w-5xl">
            <TranscriptTimeline segments={meeting.transcript} />
          </div>
        </TabsContent>

        <TabsContent value="ask" className="mt-0 px-5 py-6 md:px-8">
          <div className="mx-auto max-w-3xl">
            <AskMeetingPanel
              dictionary={dictionary}
              question={question}
              answer={answer}
              asking={asking}
              disabled={!meeting}
              onQuestionChange={onQuestionChange}
              onAsk={onAsk}
            />
          </div>
        </TabsContent>

        <TabsContent value="tasks" className="mt-0 px-5 py-6 md:px-8">
          <section className="ms-card mx-auto max-w-5xl p-4">
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

        <TabsContent value="prep" className="mt-0 px-5 py-6 md:px-8">
          <section className="ms-card mx-auto max-w-3xl p-4 text-sm leading-6 text-muted-foreground">
            Gmail-aware prep, linked Drive docs, and previous context packets will
            land here after the Calendar/Drive spine is running.
          </section>
        </TabsContent>

        <TabsContent value="followup" className="mt-0 px-5 py-6 md:px-8">
          <section className="ms-card mx-auto max-w-3xl p-4 text-sm leading-6 text-muted-foreground">
            {meeting.intelligence?.followUpDraft ??
              "Follow-up draft will appear after structured intelligence runs."}
          </section>
        </TabsContent>
      </Tabs>
    </div>
  )
}
