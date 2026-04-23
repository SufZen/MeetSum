import {
  BotIcon,
  CalendarIcon,
  DatabaseIcon,
  GitBranchIcon,
  MailIcon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
  UploadIcon,
} from "lucide-react"

import { LanguageSwitcher } from "@/components/language-switcher"
import { MeetingDetail } from "@/components/meeting-detail"
import { MeetingIntelligencePanel } from "@/components/meeting-intelligence-panel"
import { MeetingList } from "@/components/meeting-list"
import { MeetingRecorder } from "@/components/meeting-recorder"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import type { MeetingRecord } from "@/lib/meetings/repository"

const navIcons = [CalendarIcon, BotIcon, MailIcon, GitBranchIcon, DatabaseIcon]

export function AppShell({
  dictionary,
  locale,
  meetings,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  meetings: MeetingRecord[]
}) {
  const selectedMeeting = meetings[0] ?? null
  const totalActionItems = meetings.reduce(
    (count, meeting) => count + (meeting.summary?.actionItems.length ?? 0),
    0
  )
  const navItems = [
    dictionary.navMeetings,
    dictionary.navMemory,
    dictionary.navWorkspace,
    dictionary.navAutomations,
    dictionary.navStorage,
  ]

  return (
    <main className="min-h-svh bg-background">
      <div className="grid min-h-svh grid-cols-1 lg:grid-cols-[272px_minmax(0,1fr)]">
        <aside className="border-b bg-sidebar p-4 lg:border-r lg:border-b-0">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <SparklesIcon aria-hidden="true" className="size-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold">MeetSum</h1>
              <p className="truncate text-sm text-muted-foreground">
                {dictionary.appSubtitle}
              </p>
            </div>
          </div>

          <Separator className="my-4" />

          <nav className="grid gap-1 text-sm">
            {navItems.map((label, index) => {
              const Icon = navIcons[index]

              return (
                <Button
                  key={label}
                  variant={index === 0 ? "secondary" : "ghost"}
                  className="h-10 justify-start rounded-md"
                >
                  <Icon data-icon="inline-start" />
                  {label}
                </Button>
              )
            })}
          </nav>

          <Separator className="my-4" />

          <div className="grid gap-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {dictionary.workspaceSync}
              </span>
              <Badge variant="secondary" className="rounded-sm">
                {dictionary.queued}
              </Badge>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Badge variant="outline" className="justify-center rounded-sm">
                Calendar
              </Badge>
              <Badge variant="outline" className="justify-center rounded-sm">
                Gmail
              </Badge>
              <Badge variant="outline" className="justify-center rounded-sm">
                Drive
              </Badge>
            </div>
          </div>
        </aside>

        <section className="flex min-w-0 flex-col">
          <header className="border-b bg-background/95 p-4">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">
                  {dictionary.controlPlane}
                </p>
                <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
                  {dictionary.pageTitle}
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <LanguageSwitcher locale={locale} />
                <MeetingRecorder
                  labels={{
                    ready: dictionary.recorderReady,
                    record: dictionary.record,
                    stop: dictionary.stop,
                    recording: dictionary.recording,
                    blocked: dictionary.recorderBlocked,
                    unsupported: dictionary.recorderUnsupported,
                  }}
                />
                <Button variant="outline" className="h-9">
                  <UploadIcon data-icon="inline-start" />
                  {dictionary.upload}
                </Button>
                <Button className="h-9">
                  <SendIcon data-icon="inline-start" />
                  {dictionary.runAgent}
                </Button>
              </div>
            </div>
          </header>

          <div className="grid flex-1 grid-cols-1 xl:grid-cols-[minmax(300px,400px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(300px,400px)_minmax(0,1fr)_340px]">
            <div className="border-b p-4 xl:border-r xl:border-b-0">
              <div className="mb-4 flex h-10 items-center gap-2 rounded-md border bg-card px-3">
                <SearchIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                <Input
                  placeholder={dictionary.commandPlaceholder}
                  className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                />
              </div>
              <MeetingList meetings={meetings} locale={locale} />
            </div>

            <div className="min-w-0 border-b p-4 xl:border-r xl:border-b-0">
              <MeetingDetail dictionary={dictionary} meeting={selectedMeeting} />
            </div>

            <aside className="p-4 xl:col-span-2 xl:border-t 2xl:col-span-1 2xl:border-t-0">
              <MeetingIntelligencePanel
                dictionary={dictionary}
                meeting={selectedMeeting}
                totalActionItems={totalActionItems}
              />
            </aside>
          </div>
        </section>
      </div>
    </main>
  )
}
