"use client"

import { useMemo, useState } from "react"
import { BotIcon, CircleAlertIcon, LockIcon } from "lucide-react"
import { toast } from "sonner"

import { BdiMessage } from "@/components/bot/bdi-message"
import { botApi } from "@/components/bot/bot-api"
import { BOT_PLATFORM_MESSAGE } from "@/components/bot/bot-ui-state"
import {
  LINK_REASON_MESSAGE,
  buildJoinPreview,
  buildJoinRequest,
} from "@/components/bot/join-meeting-state"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import type { BotJoinLanguage, JoinBotResponse } from "@/lib/bot/api-types"
import { diagnoseMeetingLink, extractMeetingLinks } from "@/lib/bot/meeting-url"
import { DEFAULT_BOT_NAME } from "@/lib/bot/types"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { formatMessage } from "@/lib/i18n/messages"
import type { BotMessageKey } from "@/lib/i18n/m7/bot"

const parser = {
  extract: (text: string) => extractMeetingLinks(text),
  diagnose: (text: string) => diagnoseMeetingLink(text),
}

/**
 * "Send bot to a meeting" (M7 C3). The input takes a URL or pasted invite
 * text of unknown language (dir="auto"); a live preview runs A's pure
 * parser client-side. Errors name the cause and the next step.
 */
export function JoinMeetingDialog({
  dictionary,
  open,
  onOpenChange,
  onJoined,
}: {
  dictionary: Dictionary
  open: boolean
  onOpenChange: (open: boolean) => void
  onJoined?: (response: JoinBotResponse) => void
}) {
  const [input, setInput] = useState("")
  const [title, setTitle] = useState("")
  const [language, setLanguage] = useState<BotJoinLanguage>("auto")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<BotMessageKey | null>(null)
  const preview = useMemo(() => buildJoinPreview(input, parser), [input])

  const reset = () => {
    setInput("")
    setTitle("")
    setLanguage("auto")
    setError(null)
  }

  const submit = async () => {
    if (preview.kind !== "found" || busy) return
    setBusy(true)
    setError(null)

    const result = await botApi.join(buildJoinRequest({ input, title, language }))

    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success(
      formatMessage(result.body.reused ? dictionary.botJoinReused : dictionary.botJoinSent, {
        title: result.body.meeting.title,
      })
    )
    onJoined?.(result.body)
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>{dictionary.botJoinTitle}</DialogTitle>
            <DialogDescription>
              <BdiMessage template={dictionary.botJoinDescription} values={{ name: DEFAULT_BOT_NAME }} />
            </DialogDescription>
          </DialogHeader>

          <label className="grid gap-1.5 text-sm font-medium">
            {dictionary.botJoinInputLabel}
            <Textarea
              dir="auto"
              autoFocus
              rows={4}
              maxLength={8192}
              value={input}
              placeholder={dictionary.botJoinInputPlaceholder}
              aria-invalid={preview.kind === "rejected" || undefined}
              aria-describedby="bot-join-preview"
              onChange={(event) => {
                setInput(event.target.value)
                setError(null)
              }}
            />
          </label>

          <div id="bot-join-preview" aria-live="polite" className="min-h-10 text-sm">
            {preview.kind === "found" ? (
              <div className="flex items-start gap-2.5 rounded-md bg-surface-2 p-2.5">
                <BotIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand-text" />
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-medium">
                    <BdiMessage
                      template={dictionary.botJoinPreviewFound}
                      values={{ platform: dictionary[BOT_PLATFORM_MESSAGE[preview.link.platform]] }}
                    />
                  </span>
                  <span className="text-xs text-fg-3">
                    {dictionary.botJoinPreviewId}:{" "}
                    <bdi className="font-mono">{preview.link.nativeMeetingId}</bdi>
                  </span>
                  <bdi dir="ltr" className="truncate font-mono text-xs text-fg-3">
                    {preview.link.redactedUrl}
                  </bdi>
                  {preview.link.passcode ? (
                    <span className="flex items-center gap-1 text-xs text-fg-3">
                      <LockIcon aria-hidden="true" className="size-3" />
                      {dictionary.botJoinPreviewPasscode}
                    </span>
                  ) : null}
                  {preview.extraCount > 0 ? (
                    <span className="text-xs text-fg-3">
                      {formatMessage(dictionary.botJoinPreviewMore, { count: preview.extraCount })}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : preview.kind === "rejected" ? (
              <p className="flex items-start gap-2 text-danger-text">
                <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                {dictionary[LINK_REASON_MESSAGE[preview.reason]]}
              </p>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label className="grid gap-1.5 text-sm font-medium">
              {dictionary.botJoinTitleLabel}
              <Input
                dir="auto"
                maxLength={200}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              {dictionary.botJoinLanguageLabel}
              <NativeSelect
                value={language}
                onChange={(event) => setLanguage(event.target.value as BotJoinLanguage)}
              >
                <NativeSelectOption value="auto">{dictionary.botJoinLanguageAuto}</NativeSelectOption>
                <NativeSelectOption value="he">{dictionary.botJoinLanguageHe}</NativeSelectOption>
                <NativeSelectOption value="en">{dictionary.botJoinLanguageEn}</NativeSelectOption>
              </NativeSelect>
            </label>
          </div>

          {error ? (
            <p role="alert" className="rounded-md bg-danger-soft p-2.5 text-sm text-danger-text">
              {dictionary[error]}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={busy || preview.kind !== "found"}>
              <BotIcon data-icon="inline-start" />
              {busy ? dictionary.botJoinSubmitting : dictionary.botJoinSubmit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
