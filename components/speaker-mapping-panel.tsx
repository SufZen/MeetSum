"use client"

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { CheckIcon, PencilIcon, RotateCcwIcon, UsersIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import {
  directionForLanguage,
  orderSpeakers,
  sortReasons,
  speakerColors,
  speakerDisplay,
  speakerInitials,
  SUGGESTION_REASON_KEYS,
  talkTimeShare,
} from "@/components/speaker-display"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CitedMark, SpeakerAvatar } from "@/components/ui/meeting-atoms"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useWorkspace } from "@/components/workspace-context"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"
import type { MeetingParticipant, MeetingSpeaker } from "@/lib/meetings/repository"

type SpeakersPayload = {
  speakers: MeetingSpeaker[]
  participants: MeetingParticipant[]
  totalTalkTimeMs: number
}

const ASSIGNABLE_ROLES = new Set(["organizer", "attendee", "speaker", "unknown"])

/** Fills `{key}` placeholders with nodes (isolated names, LTR numbers). */
function formatParts(template: string, values: Record<string, ReactNode>): ReactNode {
  return template.split(/(\{\w+\})/g).map((part, index) => {
    const key = /^\{(\w+)\}$/.exec(part)?.[1]

    return <Fragment key={index}>{key && key in values ? values[key] : part}</Fragment>
  })
}

const NUMERIC = "font-mono tabular-nums [direction:ltr] [unicode-bidi:isolate]"

async function readJson(response: Response) {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

/**
 * Speaker review (M3 C6): one row per diarized speaker with colour, localized
 * label, talk-time share and resolved name; AI suggestions as an iris chip
 * with reasons; confirm / reject, participant select, rename, merge and
 * "Suggest again". Mapping never rewrites transcript text.
 */
export function SpeakerMappingPanel({
  meetingId,
  dictionary: t,
  meetingLanguage,
  onChanged,
  onManageParticipants,
}: {
  meetingId: string
  dictionary: Dictionary
  meetingLanguage?: string
  /** Called after any successful change so the meeting can refresh. */
  onChanged?: () => void
  onManageParticipants?: () => void
}) {
  const { can } = useWorkspace()
  const canEdit = can("meeting:write")
  const [data, setData] = useState<SpeakersPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const response = await fetch(`/api/meetings/${meetingId}/speakers`)
        const body = await readJson(response)

        if (cancelled) return
        if (!response.ok) throw new Error(String(body.error ?? t.speakersLoadFailed))
        setData(body as unknown as SpeakersPayload)
        setLoadError(null)
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : t.speakersLoadFailed)
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [meetingId, reloadKey, t.speakersLoadFailed])

  const run = useCallback(
    async (key: string, request: () => Promise<Response>, success: (body: Record<string, unknown>) => string) => {
      setBusy(key)

      try {
        const response = await request()
        const body = await readJson(response)

        if (!response.ok) throw new Error(String(body.error ?? t.speakersActionFailed))
        toast.success(success(body))
        setReloadKey((value) => value + 1)
        onChanged?.()
        return true
      } catch (error) {
        toast.error(t.speakersActionFailed, {
          description: error instanceof Error ? error.message : undefined,
        })
        return false
      } finally {
        setBusy(null)
      }
    },
    [onChanged, t.speakersActionFailed]
  )

  const patchSpeaker = (speakerId: string, body: Record<string, unknown>) =>
    run(
      speakerId,
      () =>
        fetch(`/api/meetings/${meetingId}/speakers/${speakerId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      () => t.speakersUpdated
    )

  const merge = (sourceSpeakerId: string, targetSpeakerId: string) =>
    run(
      sourceSpeakerId,
      () =>
        fetch(`/api/meetings/${meetingId}/speakers/merge`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceSpeakerId, targetSpeakerId }),
        }),
      () => t.speakersMerged
    )

  const suggestAgain = () =>
    run(
      "suggest",
      () => fetch(`/api/meetings/${meetingId}/speakers/suggest`, { method: "POST" }),
      (body) => formatMessage(t.speakersSuggestionsRefreshed, { count: Number(body.suggested ?? 0) })
    )

  const speakers = useMemo(() => orderSpeakers(data?.speakers ?? []), [data])
  const colors = useMemo(() => speakerColors(speakers), [speakers])
  const participants = useMemo(
    () => (data?.participants ?? []).filter((participant) => ASSIGNABLE_ROLES.has(participant.role)),
    [data]
  )
  const nameDir = directionForLanguage(meetingLanguage)

  if (loadError) {
    return (
      <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 p-3 text-sm text-fg-2">
        <span role="alert">{t.speakersLoadFailed}</span>
        <Button size="sm" variant="secondary" onClick={() => setReloadKey((value) => value + 1)}>
          {t.retry}
        </Button>
      </section>
    )
  }

  if (!data) {
    return (
      <section aria-busy="true" className="grid gap-2 rounded-lg border border-line bg-surface-2 p-3">
        <div className="h-4 w-24 animate-pulse rounded bg-surface-3 motion-reduce:animate-none" />
        <div className="h-9 animate-pulse rounded bg-surface-3 motion-reduce:animate-none" />
      </section>
    )
  }

  return (
    <section aria-labelledby="speaker-mapping-title" className="grid gap-3 rounded-lg border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id="speaker-mapping-title" className="text-sm font-semibold text-fg">
            {t.speakersTitle}
          </h3>
          <p className="text-xs leading-5 text-fg-3">{t.speakersDescription}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {onManageParticipants ? (
            <Button size="sm" variant="ghost" onClick={onManageParticipants}>
              <UsersIcon data-icon="inline-start" aria-hidden="true" />
              {t.speakersManageParticipants}
            </Button>
          ) : null}
          {canEdit && speakers.length ? (
            <Button size="sm" variant="ai" disabled={busy === "suggest"} onClick={() => void suggestAgain()}>
              <CitedMark data-icon="inline-start" aria-hidden="true" />
              {t.speakersSuggestAgain}
            </Button>
          ) : null}
        </div>
      </div>

      {!speakers.length ? (
        <p className="rounded-md border border-dashed border-line bg-surface p-3 text-sm text-fg-3">{t.speakersEmpty}</p>
      ) : (
        <ul className="grid gap-2">
          {speakers.map((speaker) => {
            const display = speakerDisplay(speaker, data.participants, t.speakersGenericLabel)
            const color = colors.get(speaker.id) ?? 1
            const suggestion =
              speaker.mappingStatus === "suggested" || speaker.mappingStatus === "unmapped"
                ? speaker.suggestion
                : undefined
            const reasons = suggestion ? sortReasons(suggestion.reasons) : []
            const topReason = reasons[0] ? t[SUGGESTION_REASON_KEYS[reasons[0].kind]] : undefined
            const labelText = speakerDisplay(
              { ...speaker, participantId: undefined, displayName: undefined },
              [],
              t.speakersGenericLabel
            ).name
            const others = speakers.filter((candidate) => candidate.id !== speaker.id)
            const isBusy = busy === speaker.id

            return (
              <li
                key={speaker.id}
                aria-busy={isBusy || undefined}
                className="grid gap-2 rounded-md border border-line bg-surface p-2.5"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <SpeakerAvatar
                      initials={speakerInitials(display, speaker.label)}
                      color={color}
                      size="sm"
                      unconfirmed={display.unconfirmed || speaker.mappingStatus !== "confirmed"}
                    />
                    <span className="min-w-0 truncate text-sm font-medium text-fg">
                      <bdi dir={display.generic ? undefined : nameDir ?? "auto"}>{display.name}</bdi>
                    </span>
                    {!display.generic ? (
                      <span className="text-xs text-fg-3">
                        <bdi>{labelText}</bdi>
                      </span>
                    ) : null}
                    {display.unconfirmed ? (
                      <small className="text-xs text-warn-text">{t.speakersUnconfirmed}</small>
                    ) : null}
                  </span>
                  <span className="text-xs text-fg-3">
                    {formatParts(t.speakersTalkTime, {
                      percent: (
                        <span className={NUMERIC}>
                          {talkTimeShare(speaker.talkTimeMs, data.totalTalkTimeMs)}
                        </span>
                      ),
                    })}
                  </span>
                  {speaker.mappingStatus === "confirmed" ? (
                    <span className="inline-flex items-center gap-1 text-xs text-fg-2">
                      <CheckIcon aria-hidden="true" className="size-3.5" />
                      {t.speakersConfirmed}
                    </span>
                  ) : speaker.mappingStatus === "rejected" ? (
                    <span className="inline-flex items-center gap-1 text-xs text-fg-3">
                      <XIcon aria-hidden="true" className="size-3.5" />
                      {t.speakersRejected}
                    </span>
                  ) : null}
                </div>

                {suggestion ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Tooltip>
                      <TooltipTrigger
                        className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-ai-line bg-ai-soft px-2 text-xs text-ai-text outline-2 outline-offset-2 outline-transparent focus-visible:shadow-focus"
                        aria-label={`${formatMessage(t.speakersSuggestionChip, {
                          name: suggestion.name,
                          reason: topReason ?? "",
                        })}. ${t.speakersSuggestionReasons}`}
                      >
                        <CitedMark aria-hidden="true" className="size-3 shrink-0" />
                        <span className="truncate">
                          {formatParts(t.speakersSuggestionChip, {
                            name: <bdi dir={nameDir ?? "auto"}>{suggestion.name}</bdi>,
                            reason: topReason ?? "",
                          })}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <div className="grid gap-1 text-start">
                          <span className="font-medium">{t.speakersSuggestionReasons}</span>
                          <ul className="grid gap-0.5">
                            {reasons.map((reason) => (
                              <li key={`${reason.kind}-${reason.detail}`}>
                                {t[SUGGESTION_REASON_KEYS[reason.kind]]}
                                {reason.detail ? (
                                  <>
                                    {" · "}
                                    <bdi dir="auto">{reason.detail}</bdi>
                                  </>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                          <span>
                            {formatParts(t.speakersSuggestionScore, {
                              percent: <span className={NUMERIC}>{Math.round(suggestion.score * 100)}%</span>,
                            })}
                          </span>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                    {canEdit ? (
                      <>
                        <Button
                          size="xs"
                          variant="secondary"
                          disabled={isBusy}
                          aria-label={formatMessage(t.speakersConfirmSuggestion, {
                            name: suggestion.name,
                            speaker: labelText,
                          })}
                          onClick={() => void patchSpeaker(speaker.id, { action: "confirm" })}
                        >
                          <CheckIcon data-icon="inline-start" aria-hidden="true" />
                          {t.speakersConfirm}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={isBusy}
                          aria-label={formatMessage(t.speakersRejectSuggestion, {
                            name: suggestion.name,
                            speaker: labelText,
                          })}
                          onClick={() => void patchSpeaker(speaker.id, { action: "reject" })}
                        >
                          <XIcon data-icon="inline-start" aria-hidden="true" />
                          {t.speakersReject}
                        </Button>
                      </>
                    ) : null}
                  </div>
                ) : null}

                {canEdit ? (
                  renaming?.id === speaker.id ? (
                    <form
                      className="flex flex-wrap items-center gap-1.5"
                      onSubmit={async (event) => {
                        event.preventDefault()
                        const name = renaming.draft.trim()

                        if (!name) return
                        if (await patchSpeaker(speaker.id, { action: "confirm", displayName: name })) {
                          setRenaming(null)
                        }
                      }}
                    >
                      <Input
                        autoFocus
                        dir="auto"
                        maxLength={120}
                        aria-label={formatMessage(t.speakersRenameLabel, { speaker: labelText })}
                        value={renaming.draft}
                        onChange={(event) => setRenaming({ id: speaker.id, draft: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setRenaming(null)
                        }}
                        className="h-7 w-48 text-sm"
                      />
                      <Button size="xs" type="submit" variant="secondary" disabled={isBusy || !renaming.draft.trim()}>
                        {t.speakersSave}
                      </Button>
                      <Button size="xs" type="button" variant="ghost" onClick={() => setRenaming(null)}>
                        {t.speakersCancel}
                      </Button>
                    </form>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {participants.length ? (
                        <NativeSelect
                          size="sm"
                          aria-label={formatMessage(t.speakersParticipantFor, { speaker: labelText })}
                          disabled={isBusy}
                          value={speaker.mappingStatus === "confirmed" ? speaker.participantId ?? "" : ""}
                          onChange={(event) => {
                            if (event.target.value) {
                              void patchSpeaker(speaker.id, { action: "confirm", participantId: event.target.value })
                            }
                          }}
                        >
                          <NativeSelectOption value="">{t.speakersAssignParticipant}</NativeSelectOption>
                          {participants.map((participant) => (
                            <NativeSelectOption key={participant.id} value={participant.id}>
                              {participant.name}
                              {participant.email ? ` (${participant.email})` : ""}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      ) : null}
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={isBusy}
                        onClick={() =>
                          setRenaming({ id: speaker.id, draft: display.generic ? "" : display.name })
                        }
                      >
                        <PencilIcon data-icon="inline-start" aria-hidden="true" />
                        {t.speakersRename}
                      </Button>
                      {others.length ? (
                        <NativeSelect
                          size="sm"
                          aria-label={formatMessage(t.speakersMergeLabel, { speaker: labelText })}
                          disabled={isBusy}
                          value=""
                          onChange={(event) => {
                            if (event.target.value) void merge(speaker.id, event.target.value)
                          }}
                        >
                          <NativeSelectOption value="">{t.speakersMergeInto}</NativeSelectOption>
                          {others.map((other) => (
                            <NativeSelectOption key={other.id} value={other.id}>
                              {speakerDisplay(other, data.participants, t.speakersGenericLabel).name}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      ) : null}
                      {speaker.mappingStatus === "confirmed" || speaker.mappingStatus === "rejected" ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() => void patchSpeaker(speaker.id, { action: "reset" })}
                        >
                          <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
                          {t.speakersReset}
                        </Button>
                      ) : null}
                    </div>
                  )
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
