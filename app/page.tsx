import {
  ActivityIcon,
  BotIcon,
  CalendarIcon,
  DatabaseIcon,
  FileAudioIcon,
  GitBranchIcon,
  MailIcon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
  UploadIcon,
} from "lucide-react"

import { MeetingRecorder } from "@/components/meeting-recorder"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { GOOGLE_WORKSPACE_SCOPES } from "@/lib/google/workspace"
import { MEETING_STATUS_FLOW } from "@/lib/meetings/state"
import { meetingRepository } from "@/lib/meetings/store"

const statusProgress = new Map(
  MEETING_STATUS_FLOW.map((status, index) => [
    status,
    Math.round((index / (MEETING_STATUS_FLOW.length - 2)) * 100),
  ]),
)

export default function Page() {
  const meetings = meetingRepository.listMeetings()
  const selectedMeeting = meetings[0]
  const totalActionItems = meetings.reduce(
    (count, meeting) => count + (meeting.summary?.actionItems.length ?? 0),
    0,
  )

  return (
    <main className="min-h-svh bg-background">
      <div className="grid min-h-svh grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="border-b bg-muted/30 p-5 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <SparklesIcon aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">MeetSum</h1>
              <p className="text-sm text-muted-foreground">Google-first AI memory</p>
            </div>
          </div>

          <Separator className="my-5" />

          <nav className="flex flex-col gap-1 text-sm">
            {[
              ["Meetings", CalendarIcon],
              ["AI Memory", BotIcon],
              ["Google Workspace", MailIcon],
              ["Automations", GitBranchIcon],
              ["Storage", DatabaseIcon],
            ].map(([label, Icon]) => (
              <Button
                key={String(label)}
                variant={label === "Meetings" ? "secondary" : "ghost"}
                className="justify-start"
              >
                <Icon data-icon="inline-start" />
                {String(label)}
              </Button>
            ))}
          </nav>

          <Separator className="my-5" />

          <div className="flex flex-col gap-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Workspace sync</span>
              <Badge variant="secondary">queued</Badge>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Badge variant="outline">Calendar</Badge>
              <Badge variant="outline">Gmail</Badge>
              <Badge variant="outline">Drive</Badge>
            </div>
          </div>
        </aside>

        <section className="flex min-w-0 flex-col">
          <header className="border-b p-5">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Self-hosted control plane</p>
                <h2 className="text-3xl font-semibold tracking-tight">
                  Meetings, memory, automations
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <MeetingRecorder />
                <Button variant="outline">
                  <UploadIcon data-icon="inline-start" />
                  Upload
                </Button>
                <Button>
                  <SendIcon data-icon="inline-start" />
                  Run agent
                </Button>
              </div>
            </div>
          </header>

          <div className="grid flex-1 grid-cols-1 xl:grid-cols-[minmax(320px,420px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(320px,420px)_minmax(0,1fr)_340px]">
            <div className="border-b p-5 xl:border-b-0 xl:border-r">
              <div className="mb-4 flex items-center gap-2">
                <SearchIcon aria-hidden="true" className="text-muted-foreground" />
                <Input placeholder="Search meetings, Hebrew notes, decisions" />
              </div>

              <div className="flex flex-col gap-3">
                {meetings.map((meeting) => (
                  <Card key={meeting.id} className="rounded-md shadow-none">
                    <CardHeader className="gap-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <CardTitle className="truncate text-base">
                            {meeting.title}
                          </CardTitle>
                          <p className="text-sm text-muted-foreground">
                            {new Intl.DateTimeFormat("en-GB", {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(new Date(meeting.startedAt))}
                          </p>
                        </div>
                        <Badge variant="secondary">{meeting.source}</Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                      <Progress value={statusProgress.get(meeting.status) ?? 0} />
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{meeting.status.replaceAll("_", " ")}</span>
                        <span>{meeting.language.toUpperCase()}</span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>

            <div className="min-w-0 border-b p-5 xl:border-b-0 xl:border-r">
              <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <Badge variant="outline">Selected meeting</Badge>
                  <h3 className="mt-2 text-2xl font-semibold tracking-tight">
                    {selectedMeeting.title}
                  </h3>
                  <p className="text-muted-foreground">
                    {selectedMeeting.participants.join(", ")}
                  </p>
                </div>
                <div className="flex -space-x-2">
                  {selectedMeeting.participants.map((participant) => (
                    <Avatar key={participant} className="size-9 border-2 border-background">
                      <AvatarFallback>{participant.slice(0, 2)}</AvatarFallback>
                    </Avatar>
                  ))}
                </div>
              </div>

              <Tabs defaultValue="summary" className="w-full">
                <TabsList>
                  <TabsTrigger value="summary">Summary</TabsTrigger>
                  <TabsTrigger value="transcript">Transcript</TabsTrigger>
                  <TabsTrigger value="ask">Ask</TabsTrigger>
                </TabsList>
                <TabsContent value="summary" className="mt-5 flex flex-col gap-5">
                  <section>
                    <h4 className="mb-2 font-medium">Overview</h4>
                    <p className="leading-7 text-muted-foreground">
                      {selectedMeeting.summary?.overview}
                    </p>
                  </section>
                  <section>
                    <h4 className="mb-2 font-medium">Decisions</h4>
                    <ul className="flex flex-col gap-2">
                      {selectedMeeting.summary?.decisions.map((decision) => (
                        <li key={decision} className="rounded-md bg-muted p-3 text-sm">
                          {decision}
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section>
                    <h4 className="mb-2 font-medium">Action items</h4>
                    <div className="flex flex-col gap-2">
                      {selectedMeeting.summary?.actionItems.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
                        >
                          <span>{item.title}</span>
                          <Badge variant="outline">{item.owner ?? "Unassigned"}</Badge>
                        </div>
                      ))}
                    </div>
                  </section>
                </TabsContent>
                <TabsContent value="transcript" className="mt-5 flex flex-col gap-3">
                  {selectedMeeting.transcript?.map((segment) => (
                    <div key={segment.id} className="grid gap-2 rounded-md border p-3">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium">{segment.speaker}</span>
                        <span className="text-muted-foreground">
                          {Math.floor(segment.startMs / 1000)}s
                        </span>
                      </div>
                      <p className="text-sm leading-6 text-muted-foreground">
                        {segment.text}
                      </p>
                    </div>
                  ))}
                </TabsContent>
                <TabsContent value="ask" className="mt-5">
                  <Card className="rounded-md shadow-none">
                    <CardHeader>
                      <CardTitle>Ask meeting memory</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                      <Input defaultValue="What should RealizeOS receive?" />
                      <Button className="w-fit">
                        <BotIcon data-icon="inline-start" />
                        Ask
                      </Button>
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            </div>

            <aside className="p-5 xl:col-span-2 xl:border-t 2xl:col-span-1 2xl:border-t-0">
              <div className="flex flex-col gap-5">
                <section>
                  <h3 className="mb-3 font-medium">Pipeline</h3>
                  <div className="flex flex-col gap-2">
                    {["media_uploaded", "transcribing", "summarizing", "indexing"].map(
                      (status) => (
                        <div
                          key={status}
                          className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
                        >
                          <span>{status.replaceAll("_", " ")}</span>
                          <ActivityIcon aria-hidden="true" className="text-muted-foreground" />
                        </div>
                      ),
                    )}
                  </div>
                </section>

                <section>
                  <h3 className="mb-3 font-medium">Google scopes</h3>
                  <div className="flex flex-col gap-2 text-sm">
                    {Object.entries(GOOGLE_WORKSPACE_SCOPES).map(([group, scopes]) => (
                      <div key={group} className="rounded-md bg-muted p-3">
                        <div className="mb-1 font-medium capitalize">{group}</div>
                        <div className="text-xs text-muted-foreground">
                          {scopes.length} least-privilege scopes
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                <section>
                  <h3 className="mb-3 font-medium">Automation bus</h3>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <Badge variant="secondary">n8n</Badge>
                    <Badge variant="secondary">MCP</Badge>
                    <Badge variant="secondary">CLI</Badge>
                    <Badge variant="secondary">REST</Badge>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    {totalActionItems} open action items can trigger agents, webhooks,
                    RealizeOS context packets, or follow-up drafts.
                  </p>
                </section>

                <section>
                  <h3 className="mb-3 font-medium">Storage policy</h3>
                  <div className="flex items-center gap-3 rounded-md border p-3">
                    <FileAudioIcon aria-hidden="true" className="text-muted-foreground" />
                    <div>
                      <div className="text-sm font-medium">Audio-first</div>
                      <div className="text-xs text-muted-foreground">
                        Video retained only when configured
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            </aside>
          </div>
        </section>
      </div>
    </main>
  )
}
