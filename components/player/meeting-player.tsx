"use client"

/**
 * Player card (M4 C3): transport, mono time, speed, volume, optional video,
 * shortcuts, then the scrubber over the waveform and the speaker lanes with
 * markers. `dir="ltr"` in every language (time never mirrors); labels are
 * localized. Play is the meeting view's one primary action.
 */
import { useEffect, useMemo, useState } from "react"
import {
  KeyboardIcon,
  PauseIcon,
  PictureInPicture2Icon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  UnfoldVerticalIcon,
  FoldVerticalIcon,
  Volume2Icon,
  VolumeXIcon,
  VideoIcon,
  VideoOffIcon,
} from "lucide-react"

import {
  useMeetingPlayer,
  usePlayerState,
} from "@/components/player/meeting-player-provider"
import { Scrubber } from "@/components/player/scrubber"
import { ShortcutsDialog } from "@/components/player/shortcuts-dialog"
import { SpeakerTimelineBar, type LaneSpeaker } from "@/components/player/speaker-timeline-bar"
import type { SpeakerDirectory } from "@/components/player/speaker-directory"
import { useMediaPeaks } from "@/components/player/use-media-peaks"
import { Waveform } from "@/components/player/waveform"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"
import { actionForKey, isEditableTarget } from "@/lib/player/keyboard"
import { RATES, formatRate } from "@/lib/player/rate"
import { buildSpeakerRuns, type SpeakerLane } from "@/lib/player/speaker-timeline"
import { segmentSpeakerKey } from "@/lib/player/transcript-search"
import { formatClock } from "@/lib/player/time-format"
import { cn } from "@/lib/utils"

function TimeReadout() {
  const currentMs = usePlayerState((state) => state.currentMs)
  const durationMs = usePlayerState((state) => state.durationMs)

  return (
    <span className="ms-1.5 shrink-0 font-mono text-sm whitespace-nowrap text-fg tabular-nums">
      <time dir="ltr">{formatClock(currentMs)}</time>
      <span aria-hidden className="mx-1 text-fg-3">
        /
      </span>
      <time dir="ltr" className="text-fg-3">
        {durationMs > 0 ? formatClock(durationMs) : "—"}
      </time>
    </span>
  )
}

function isInsideOverlay(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'))
  )
}

export function MeetingPlayer({
  dictionary: t,
  locale,
  directory,
  compact = false,
  shortcuts = true,
  className,
}: {
  dictionary: Dictionary
  locale: string
  directory: SpeakerDirectory
  /** Reading pane scrolled: lanes fold into one. */
  compact?: boolean
  /** Install the global keyboard shortcuts. */
  shortcuts?: boolean
  className?: string
}) {
  const player = useMeetingPlayer()
  const playing = usePlayerState((state) => state.playing)
  const ready = usePlayerState((state) => state.ready)
  const error = usePlayerState((state) => state.error)
  const rate = usePlayerState((state) => state.rate)
  const muted = usePlayerState((state) => state.muted)
  const volume = usePlayerState((state) => state.volume)
  const variant = usePlayerState((state) => state.variant)
  const durationMs = usePlayerState((state) => state.durationMs)
  const activeSegmentIndex = usePlayerState((state) => state.activeSegmentIndex)
  const [helpOpen, setHelpOpen] = useState(false)
  const [lanesOpen, setLanesOpen] = useState(true)
  const peaks = useMediaPeaks(player.mediaBaseUrl, Boolean(player.hasMedia && player.media?.peaks))
  const lanes = useMemo(() => buildSpeakerRuns(player.segments), [player.segments])
  const activeSegment = activeSegmentIndex >= 0 ? player.segments[activeSegmentIndex] : undefined
  const activeLaneKey = activeSegment ? segmentSpeakerKey(activeSegment) : undefined
  const currentMsForProgress = usePlayerState((state) =>
    state.durationMs > 0 ? Math.round((state.currentMs / state.durationMs) * 1000) / 1000 : 0
  )
  const pipSupported =
    typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled

  const { emitCommand, registerVideo, seek, skip, stepRate, toggle, toggleMute } = player

  useEffect(() => {
    if (!shortcuts || !player.available) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return

      const target = event.target as (HTMLElement & { type?: string }) | null
      const action = actionForKey(event, {
        dir: document.documentElement.dir === "rtl" ? "rtl" : "ltr",
        editable: isEditableTarget(target),
        dialogOpen: isInsideOverlay(event.target),
      })

      if (!action) return

      // A focused button/slider handles Space and Enter itself.
      if (action.type === "toggle" && event.code === "Space" && target?.closest("button,[role='slider'],a")) {
        return
      }
      // Arrow keys belong to composite widgets (tabs, radio groups, menus).
      if (
        event.code.startsWith("Arrow") &&
        target?.closest("[role='tablist'],[role='radiogroup'],[role='menubar'],[role='slider'],[role='listbox']")
      ) {
        return
      }

      event.preventDefault()
      switch (action.type) {
        case "toggle":
          toggle()
          break
        case "skip":
          skip(action.ms)
          break
        case "rate":
          stepRate(action.step)
          break
        case "seekPercent":
          seek((player.store.getState().durationMs * action.percent) / 100, { source: "keyboard" })
          break
        case "toggleFollow":
          emitCommand("toggleFollow")
          break
        case "focusSearch":
          emitCommand("focusSearch")
          break
        case "help":
          setHelpOpen(true)
          break
        case "mute":
          toggleMute()
          break
      }
    }

    window.addEventListener("keydown", onKeyDown)

    return () => window.removeEventListener("keydown", onKeyDown)
  }, [emitCommand, player.available, player.store, seek, shortcuts, skip, stepRate, toggle, toggleMute])

  const speakerFor = (lane: SpeakerLane): LaneSpeaker => {
    const resolved = directory.forSegment({ speaker: lane.label, speakerId: lane.speakerId })

    return {
      name: resolved.name,
      initials: resolved.initials,
      color: resolved.color,
      unconfirmed: resolved.unconfirmed,
    }
  }

  const noMedia = error === "no_media"
  const failed = error === "failed"
  const showLanes = lanesOpen && !compact
  const hasVideo = Boolean(player.hasMedia && player.media?.video)

  return (
    <section
      role="region"
      aria-label={t.playerRegion}
      dir="ltr"
      className={cn(
        "relative rounded-xl bg-surface-2 px-3.5 ring-1 ring-line ring-inset transition-[padding] duration-(--dur-4) ease-out",
        compact ? "py-2" : "py-2.5",
        className
      )}
    >
      {variant === "video" && hasVideo ? (
        <video
          ref={registerVideo}
          src={`${player.mediaBaseUrl}/media?variant=video`}
          playsInline
          muted
          preload="metadata"
          className="mb-2 aspect-video max-h-64 w-full rounded-lg bg-fg object-contain"
        />
      ) : null}

      <div className="flex min-w-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t.playerBack10}
          title={t.playerBack10}
          onClick={() => skip(-10_000)}
          disabled={durationMs <= 0}
        >
          <RotateCcwIcon />
        </Button>
        <Button
          size="icon"
          className="size-9 rounded-full"
          aria-label={playing ? t.playerPause : t.playerPlay}
          title={playing ? t.playerPause : t.playerPlay}
          disabled={!player.hasMedia || failed}
          onClick={toggle}
        >
          {playing ? <PauseIcon className="fill-current" /> : <PlayIcon className="fill-current" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t.playerForward10}
          title={t.playerForward10}
          onClick={() => skip(10_000)}
          disabled={durationMs <= 0}
        >
          <RotateCwIcon />
        </Button>
        <TimeReadout />

        {player.resumeMs !== undefined && player.hasMedia && !playing ? (
          <Button
            variant="secondary"
            size="xs"
            className="ms-2 rounded-full"
            onClick={() => seek(player.resumeMs ?? 0, { source: "deep_link", play: true })}
          >
            <PlayIcon className="fill-current" />
            {formatMessage(t.playerResumeAt, { time: formatClock(player.resumeMs) })}
          </Button>
        ) : null}

        <span className="min-w-0 flex-1" />

        {noMedia ? (
          <span className="truncate text-xs text-fg-3">{t.playerNoMedia}</span>
        ) : failed ? (
          <span className="flex items-center gap-2 text-xs text-danger-text">
            {t.playerError}
            <Button variant="secondary" size="xs" onClick={player.retry}>
              {t.playerRetry}
            </Button>
          </span>
        ) : !ready ? (
          <span className="truncate text-xs text-fg-3">{t.playerLoading}</span>
        ) : null}

        {player.hasMedia ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="secondary"
                    size="xs"
                    className="font-mono tabular-nums"
                    aria-label={`${t.playerSpeed}: ${formatRate(rate)}`}
                  />
                }
              >
                {formatRate(rate)}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-24">
                <DropdownMenuRadioGroup
                  value={String(rate)}
                  onValueChange={(value) => player.setRate(Number(value))}
                >
                  {RATES.map((option) => (
                    <DropdownMenuRadioItem key={option} value={String(option)} className="font-mono">
                      {formatRate(option)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={muted ? t.playerUnmute : t.playerMute}
              title={muted ? t.playerUnmute : t.playerMute}
              onClick={toggleMute}
            >
              {muted || volume === 0 ? <VolumeXIcon /> : <Volume2Icon />}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              aria-label={t.playerVolume}
              onChange={(event) => player.setVolume(Number(event.target.value))}
              className="hidden h-1 w-16 cursor-pointer accent-brand inbox:block"
            />
            {hasVideo ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={variant === "video" ? t.playerVideoHide : t.playerVideoShow}
                title={variant === "video" ? t.playerVideoHide : t.playerVideoShow}
                aria-pressed={variant === "video"}
                onClick={() => player.setVariant(variant === "video" ? "audio" : "video")}
              >
                {variant === "video" ? <VideoOffIcon /> : <VideoIcon />}
              </Button>
            ) : null}
            {variant === "video" && hasVideo && pipSupported ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t.playerPip}
                title={t.playerPip}
                onClick={player.requestPictureInPicture}
              >
                <PictureInPicture2Icon />
              </Button>
            ) : null}
          </>
        ) : null}
        {lanes.length > 1 && !compact ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={lanesOpen ? t.playerSpeakersCollapse : t.playerSpeakersExpand}
            title={lanesOpen ? t.playerSpeakersCollapse : t.playerSpeakersExpand}
            aria-expanded={lanesOpen}
            onClick={() => setLanesOpen((open) => !open)}
          >
            {lanesOpen ? <FoldVerticalIcon /> : <UnfoldVerticalIcon />}
          </Button>
        ) : null}
        {shortcuts ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t.playerShortcuts}
            title={t.playerShortcuts}
            onClick={() => setHelpOpen(true)}
          >
            <KeyboardIcon />
          </Button>
        ) : null}
      </div>

      <div className={cn("grid gap-1", compact ? "mt-1.5" : "mt-2.5", showLanes && lanes.length ? "rail:ps-7" : "")}>
        <Scrubber
          durationMs={durationMs}
          label={t.playerSeek}
          timeOfTemplate={t.playerTimeOf}
          locale={locale}
          onToggle={toggle}
          onSeek={(ms, source) => seek(ms, { source })}
        >
          <Waveform peaks={peaks} progress={currentMsForProgress} className={compact ? "h-5" : "h-7"} />
        </Scrubber>
        <SpeakerTimelineBar
          lanes={lanes}
          durationMs={durationMs}
          speakerFor={speakerFor}
          activeLaneKey={activeLaneKey}
          compact={!showLanes}
          markers={player.markers}
          markerLabels={{
            action_item: t.playerMarkerAction,
            search_match: t.playerMarkerMatch,
            chapter: t.playerMarkerChapter,
          }}
          speakerAtTemplate={t.playerSpeakerAt}
          onSeek={(ms, source) => seek(ms, { source })}
        />
      </div>

      {shortcuts ? <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} dictionary={t} /> : null}
    </section>
  )
}
