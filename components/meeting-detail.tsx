import { BotIcon, FileAudioIcon } from "lucide-react"

import { ActionItemList } from "@/components/action-item-list"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { MeetingRecord } from "@/lib/meetings/repository"

export function MeetingDetail({
  dictionary,
  meeting,
  askQuestion,
  askAnswer,
  asking,
  onAskQuestionChange,
  onAsk,
  onToggleActionItem,
}: {
  dictionary: Dictionary
  meeting: MeetingRecord | null
  askQuestion?: string
  askAnswer?: string
  asking?: boolean
  onAskQuestionChange?: (value: string) => void
  onAsk?: () => void
  onToggleActionItem?: Parameters<typeof ActionItemList>[0]["onToggle"]
}) {
  if (!meeting) {
    return (
      <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 text-center">
        <FileAudioIcon aria-hidden="true" className="size-10 text-muted-foreground" />
        <h3 className="text-xl font-semibold">{dictionary.noMeetingsTitle}</h3>
        <p className="max-w-sm text-sm leading-6 text-muted-foreground">
          {dictionary.noMeetingsDescription}
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Badge variant="outline" className="rounded-sm">
            {dictionary.selectedMeeting}
          </Badge>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">
            {meeting.title}
          </h2>
          <p className="break-words text-sm text-muted-foreground">
            {meeting.participants.join(", ")}
          </p>
        </div>
        <div className="flex -space-x-2 rtl:space-x-reverse">
          {meeting.participants.map((participant) => (
            <Avatar key={participant} className="size-9 border-2 border-background">
              <AvatarFallback>{participant.slice(0, 2)}</AvatarFallback>
            </Avatar>
          ))}
        </div>
      </div>

      <Tabs defaultValue="summary" className="w-full">
        <TabsList className="grid w-full max-w-md grid-cols-3">
          <TabsTrigger value="summary">{dictionary.summary}</TabsTrigger>
          <TabsTrigger value="transcript">{dictionary.transcript}</TabsTrigger>
          <TabsTrigger value="ask">{dictionary.ask}</TabsTrigger>
        </TabsList>
        <TabsContent value="summary" className="mt-5 grid gap-5">
          <section>
            <h3 className="mb-2 text-sm font-semibold">{dictionary.overview}</h3>
            <p className="leading-7 text-muted-foreground">
              {meeting.summary?.overview}
            </p>
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold">{dictionary.decisions}</h3>
            <div className="grid gap-2">
              {meeting.summary?.decisions.map((decision) => (
                <div key={decision} className="rounded-md bg-muted p-3 text-sm">
                  {decision}
                </div>
              ))}
            </div>
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold">
              {dictionary.actionItems}
            </h3>
            <ActionItemList
              items={meeting.summary?.actionItems}
              unassigned={dictionary.unassigned}
              onToggle={onToggleActionItem}
            />
          </section>
        </TabsContent>
        <TabsContent value="transcript" className="mt-5 grid gap-3">
          {meeting.transcript?.map((segment) => (
            <div key={segment.id} className="grid gap-2 rounded-md border p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{segment.speaker}</span>
                <span className="text-muted-foreground">
                  {Math.floor(segment.startMs / 1000)}s
                </span>
              </div>
              <p className="text-sm leading-6 text-muted-foreground">{segment.text}</p>
            </div>
          ))}
        </TabsContent>
        <TabsContent value="ask" className="mt-5">
          <Card className="rounded-md shadow-none">
            <CardHeader>
              <CardTitle>{dictionary.askMeetingMemory}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Input
                value={askQuestion ?? dictionary.askDefaultQuestion}
                onChange={(event) => onAskQuestionChange?.(event.target.value)}
              />
              <Button className="w-fit" onClick={onAsk} disabled={asking}>
                <BotIcon data-icon="inline-start" />
                {asking ? "Thinking..." : dictionary.ask}
              </Button>
              {askAnswer && (
                <p className="rounded-md border bg-muted p-3 text-sm leading-6 text-muted-foreground">
                  {askAnswer}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
