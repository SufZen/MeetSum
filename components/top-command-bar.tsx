"use client"

import { type ChangeEvent, useEffect, useState } from "react"
import {
  BotIcon,
  ChevronDownIcon,
  FolderSearchIcon,
  MoonIcon,
  RefreshCwIcon,
  SearchIcon,
  SunIcon,
  UserPlusIcon,
} from "lucide-react"

import type { BrowserRecorder } from "@/components/bot/use-browser-recorder"
import { isPaletteShortcut, openCommandPalette } from "@/components/command-palette"
import { LanguageSwitcher } from "@/components/language-switcher"
import { MediaIngestionDrawer } from "@/components/media-ingestion-drawer"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { PendingUploadsIndicator } from "@/components/pwa/pending-uploads-indicator"
import { Button } from "@/components/ui/button"
import { CitedMark } from "@/components/ui/meeting-atoms"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { useWorkspace } from "@/components/workspace-context"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"

export type SyncTarget = "calendar" | "gmail"

export type AiProviderStatus = {
  configured: boolean
  label: string
  detail: string
}

export function TopCommandBar({
  dictionary,
  locale,
  query,
  pending,
  syncing,
  uploadOpen,
  onQueryChange,
  onUploadOpenChange,
  onFileChange,
  onDesktopFileChange,
  onRecordingReady,
  onSync,
  onFindDriveRecordings,
  darkMode,
  onToggleDarkMode,
  aiStatus,
  onInvite,
  recorder,
  recordingMeetingId,
  recordOpen,
  onRecordOpenChange,
  desktopOpen,
  onDesktopOpenChange,
  onSendBot,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  query: string
  pending?: boolean
  syncing?: boolean
  uploadOpen?: boolean
  onQueryChange: (value: string) => void
  onUploadOpenChange?: (open: boolean) => void
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void
  onDesktopFileChange: (event: ChangeEvent<HTMLInputElement>) => void
  onRecordingReady: (file: File) => void
  onSync: (target: SyncTarget) => void
  onFindDriveRecordings: () => void
  darkMode: boolean
  onToggleDarkMode: () => void
  /** Primary AI provider health from /api/ai/providers/status; undefined until loaded. */
  aiStatus?: AiProviderStatus
  /** Opens the admin panel's members area (shown to member managers). */
  onInvite?: () => void
  /** M7: the shell's browser recorder, so recording (and the dock) survives closing the sheet. */
  recorder?: BrowserRecorder
  /** Meeting a browser recording is attached to (dock "Open meeting"). */
  recordingMeetingId?: string | null
  /** Controlled recorder sheet (`?record=1` opens it; it never starts capture). */
  recordOpen?: boolean
  onRecordOpenChange?: (open: boolean) => void
  /** Controlled desktop-import sheet (opened by the blocked-bot fallback). */
  desktopOpen?: boolean
  onDesktopOpenChange?: (open: boolean) => void
  /** Opens "Send bot to a meeting"; undefined hides it (bot disabled or no meeting:create). */
  onSendBot?: () => void
}) {
  const { can, activeWorkspace } = useWorkspace()
  const [recorderEnabled, setRecorderEnabled] = useState(true)
  const activeWorkspaceId = activeWorkspace?.id
  const sendBotVisible = Boolean(onSendBot) && can("meeting:create")

  // `pwaRecorderEnabled` (workspace setting) hides the browser recorder.
  useEffect(() => {
    let cancelled = false

    void fetch("/api/settings")
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body) => {
        if (!cancelled && body?.settings) {
          setRecorderEnabled(body.settings.pwaRecorderEnabled !== false)
        }
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId])

  useEffect(() => {
    // M6: Ctrl/Cmd+K opens the command palette. The app-wide
    // CommandPaletteHost listens for the same shortcut; whichever listener
    // runs first marks the event handled so the palette opens exactly once.
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !isPaletteShortcut(event)) return
      event.preventDefault()
      openCommandPalette()
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  return (
    <header className="sticky top-0 z-30 flex min-h-14 flex-col gap-2 border-b border-line bg-surface px-4 py-2 backdrop-blur lg:flex-row lg:items-center lg:justify-between">
      <div className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-surface-2 px-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] lg:max-w-[390px]">
        <SearchIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={dictionary.commandPlaceholder}
          className="h-7 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
        />
        <kbd className="hidden min-w-12 shrink-0 whitespace-nowrap rounded border border-line bg-surface-2 px-1.5 py-0.5 text-center font-mono text-2xs text-muted-foreground sm:inline-flex">
          Ctrl K
        </kbd>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {onInvite && can("members:manage") ? (
          <Button
            variant="outline"
            className="hidden h-8 rounded-md border-line bg-surface text-brand-text hover:bg-brand-soft md:inline-flex"
            onClick={onInvite}
          >
            <UserPlusIcon data-icon="inline-start" className="size-4" />
            {dictionary.invitationsInvite}
          </Button>
        ) : null}
        <MediaIngestionDrawer
          dictionary={dictionary}
          pending={pending}
          open={uploadOpen}
          onOpenChange={onUploadOpenChange}
          onFileChange={onFileChange}
          onRecordingReady={onRecordingReady}
        />
        {recorderEnabled || sendBotVisible ? (
          // Record split button: record in this browser, or send the bot.
          <div className="flex items-center gap-0.5">
            {recorderEnabled ? (
              <MediaIngestionDrawer
                dictionary={dictionary}
                pending={pending}
                mode="record"
                open={recordOpen}
                onOpenChange={onRecordOpenChange}
                onFileChange={onFileChange}
                onRecordingReady={onRecordingReady}
                recorder={recorder}
                meetingId={recordingMeetingId}
              />
            ) : null}
            {sendBotVisible ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="record"
                      size={recorderEnabled ? "icon" : "default"}
                      className="h-9"
                      aria-label={dictionary.botJoinMenu}
                      title={dictionary.botJoinMenu}
                    />
                  }
                >
                  {recorderEnabled ? null : <BotIcon data-icon="inline-start" />}
                  {recorderEnabled ? null : dictionary.botJoinMenu}
                  <ChevronDownIcon aria-hidden="true" className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={onSendBot}>
                    <BotIcon aria-hidden="true" className="size-4" />
                    {dictionary.botJoinMenu}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        ) : null}
        <MediaIngestionDrawer
          dictionary={dictionary}
          pending={pending}
          mode="desktop"
          open={desktopOpen}
          onOpenChange={onDesktopOpenChange}
          onFileChange={onDesktopFileChange}
          onRecordingReady={onRecordingReady}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                className="h-8 min-w-24 rounded-md border-line bg-surface text-brand-text hover:bg-brand-soft"
                disabled={syncing}
              />
            }
          >
            <RefreshCwIcon data-icon="inline-start" className="size-4" />
            {syncing ? dictionary.syncing : dictionary.sync}
            <ChevronDownIcon aria-hidden="true" className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onSync("calendar")}>
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              {dictionary.calendarSync}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onFindDriveRecordings}>
              <FolderSearchIcon aria-hidden="true" className="size-4" />
              {dictionary.findDriveRecordings}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSync("gmail")}>
              {dictionary.gmailContext}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon"
          className="hidden rounded-full border border-line bg-surface text-ai-text sm:inline-flex"
          disabled
          title="Provider details live in Google Workspace"
        >
          <CitedMark className="size-5" />
          <span className="sr-only">AI status</span>
        </Button>
        <PendingUploadsIndicator />
        <NotificationBell locale={locale} />
        <LanguageSwitcher locale={locale} />
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          onClick={onToggleDarkMode}
        >
          {darkMode ? (
            <SunIcon aria-hidden="true" className="size-5" />
          ) : (
            <MoonIcon aria-hidden="true" className="size-5" />
          )}
          <span className="sr-only">Toggle dark mode</span>
        </Button>
        {aiStatus ? (
          <span
            role="status"
            title={`${aiStatus.label}: ${aiStatus.detail}`}
            className={`size-2.5 rounded-full ${
              aiStatus.configured ? "bg-emerald-500" : "bg-amber-500"
            }`}
          >
            <span className="sr-only">
              {aiStatus.label} {aiStatus.configured ? "configured" : "not configured"}
            </span>
          </span>
        ) : null}
      </div>
    </header>
  )
}
