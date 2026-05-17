import { BotIcon, SendIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Dictionary } from "@/lib/i18n/dictionaries"

export function AskMeetingPanel({
  dictionary,
  question,
  answer,
  asking,
  disabled,
  onQuestionChange,
  onAsk,
}: {
  dictionary: Dictionary
  question: string
  answer?: string
  asking?: boolean
  disabled?: boolean
  onQuestionChange: (value: string) => void
  onAsk: () => void
}) {
  return (
    <section className="grid gap-3 rounded-md border bg-card p-4">
      <div className="flex items-center gap-2">
        <BotIcon aria-hidden="true" className="size-4 text-primary" />
        <h3 className="text-sm font-semibold">{dictionary.askMeetingMemory}</h3>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={question}
          onChange={(event) => onQuestionChange(event.target.value)}
          disabled={disabled || asking}
          placeholder={dictionary.askDefaultQuestion}
          className="min-h-10"
        />
        <Button
          className="min-h-10 shrink-0"
          disabled={disabled || asking || !question.trim()}
          onClick={onAsk}
        >
          <SendIcon data-icon="inline-start" />
          {asking ? "Thinking..." : dictionary.ask}
        </Button>
      </div>
      {answer && (
        <p className="rounded-md border bg-muted/60 p-3 text-sm leading-6 text-muted-foreground">
          {answer}
        </p>
      )}
    </section>
  )
}
