"use client"

/**
 * Reassign a transcript line's speaker (M4 C4): pick a known speaker or
 * create "New speaker…", optionally for the whole turn.
 */
import { useState, type ReactElement } from "react"
import { CheckIcon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { SpeakerAvatar } from "@/components/ui/meeting-atoms"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import type { SegmentSpeaker } from "@/components/speaker-display"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { MeetingSpeaker } from "@/lib/meetings/repository"
import { orderByFirstSpeech } from "@/lib/player/speaker-colors"

export type SpeakerChoice =
  | { speakerId: string; scope: "segment" | "turn" }
  | { newSpeakerName: string; scope: "segment" | "turn" }

export function SpeakerPicker({
  open,
  onOpenChange,
  trigger,
  speakers,
  currentSpeakerId,
  describe,
  dictionary: t,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactElement
  speakers: readonly MeetingSpeaker[]
  currentSpeakerId?: string
  describe: (speaker: MeetingSpeaker) => SegmentSpeaker
  dictionary: Dictionary
  onPick: (choice: SpeakerChoice) => void
}) {
  const [wholeTurn, setWholeTurn] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const scope = wholeTurn ? "turn" : "segment"

  const close = () => {
    setCreating(false)
    setName("")
    onOpenChange(false)
  }

  return (
    <Popover open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" className="w-72 gap-2 p-2">
        <PopoverTitle className="px-1.5 pt-1 text-sm">{t.transcriptSpeakerPickerTitle}</PopoverTitle>
        <div role="listbox" aria-label={t.transcriptSpeakerPickerTitle} className="grid gap-0.5">
          {orderByFirstSpeech(speakers).map((speaker) => {
            const display = describe(speaker)
            const selected = speaker.id === currentSpeakerId

            return (
              <button
                key={speaker.id}
                type="button"
                role="option"
                aria-selected={selected}
                className="flex h-8 items-center gap-2 rounded-md px-1.5 text-start text-sm hover:bg-surface-3 focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
                onClick={() => {
                  onPick({ speakerId: speaker.id, scope })
                  close()
                }}
              >
                <SpeakerAvatar
                  initials={display.initials}
                  color={display.color}
                  size="xs"
                  unconfirmed={display.unconfirmed}
                />
                <bdi className="min-w-0 flex-1 truncate">{display.name}</bdi>
                {selected ? <CheckIcon aria-hidden className="size-4 text-brand-text" /> : null}
              </button>
            )
          })}
        </div>
        {creating ? (
          <form
            className="flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              const trimmed = name.trim()

              if (!trimmed) return
              onPick({ newSpeakerName: trimmed, scope })
              close()
            }}
          >
            <Input
              dir="auto"
              autoFocus
              value={name}
              aria-label={t.transcriptNewSpeakerName}
              placeholder={t.transcriptNewSpeakerName}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" size="default" variant="secondary" disabled={!name.trim()}>
              {t.transcriptEditSave}
            </Button>
          </form>
        ) : (
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => setCreating(true)}>
            <PlusIcon />
            {t.transcriptNewSpeaker}
          </Button>
        )}
        <label className="flex items-center gap-2 border-t border-line px-1.5 pt-2 text-sm text-fg-2">
          <Checkbox checked={wholeTurn} onCheckedChange={(checked) => setWholeTurn(Boolean(checked))} />
          {t.transcriptApplyToTurn}
        </label>
      </PopoverContent>
    </Popover>
  )
}
