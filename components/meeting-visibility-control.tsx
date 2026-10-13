"use client"

import {
  ChevronDownIcon,
  GlobeIcon,
  LinkIcon,
  LockIcon,
  UsersIcon,
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { updateMeetingVisibility } from "@/components/admin/api"
import { ConfirmDialog } from "@/components/admin/confirm-dialog"
import { visibilityLabel } from "@/components/admin/labels"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useWorkspace } from "@/components/workspace-context"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type {
  MeetingRecord,
  MeetingVisibility,
} from "@/lib/meetings/repository"
import { roleRank } from "@/lib/workspaces/constants"

const ICONS: Record<MeetingVisibility, typeof LockIcon> = {
  private: LockIcon,
  workspace: UsersIcon,
  link: LinkIcon,
}

const OPTIONS: MeetingVisibility[] = ["private", "workspace", "link"]

/** Owner-or-admin check mirrored from `canManageMeeting` (server enforces). */
export function useCanManageMeeting(
  meeting: Pick<MeetingRecord, "ownerUserId">
): boolean {
  const { me, role } = useWorkspace()

  if (role && roleRank(role) >= roleRank("admin")) return true

  return Boolean(
    me?.user.id && meeting.ownerUserId && meeting.ownerUserId === me.user.id
  )
}

export function MeetingVisibilityControl({
  meeting,
  dictionary: t,
  onChanged,
  onRequestShare,
}: {
  meeting: MeetingRecord
  dictionary: Dictionary
  onChanged: (visibility: MeetingVisibility) => void
  /** `link` is reached by creating a share link (Share dialog). */
  onRequestShare: () => void
}) {
  const canManage = useCanManageMeeting(meeting)
  const current: MeetingVisibility = meeting.visibility ?? "workspace"
  const [pending, setPending] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<MeetingVisibility>()
  const CurrentIcon = ICONS[current] ?? GlobeIcon
  const { label, hint } = visibilityLabel(t, current)

  async function apply(visibility: MeetingVisibility) {
    setPending(true)
    try {
      const result = await updateMeetingVisibility(meeting.id, visibility)

      onChanged(result.visibility)
      toast.success(t.visibilityUpdated)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.actionFailed)
      throw error
    } finally {
      setPending(false)
    }
  }

  function select(visibility: MeetingVisibility) {
    if (visibility === current) return

    if (visibility === "link") {
      onRequestShare()
      return
    }

    if (current === "link") {
      setConfirmTarget(visibility)
      return
    }

    void apply(visibility).catch(() => undefined)
  }

  const badgeClass =
    "inline-flex h-6 items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 text-xs font-medium text-foreground"

  if (!canManage) {
    return (
      <span
        className={badgeClass}
        title={`${hint}. ${t.visibilityReadOnly}`}
        aria-label={`${t.visibilityLabel}: ${label}`}
      >
        <CurrentIcon aria-hidden="true" className="size-3.5" />
        {label}
      </span>
    )
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={pending}
          render={
            <button
              type="button"
              className={`${badgeClass} hover:bg-brand-soft`}
              aria-label={`${t.visibilityLabel}: ${label}`}
              title={hint}
            />
          }
        >
          <CurrentIcon aria-hidden="true" className="size-3.5" />
          {label}
          <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t.visibilityLabel}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={current}
              onValueChange={(value) => select(value as MeetingVisibility)}
            >
              {OPTIONS.map((option) => {
                const Icon = ICONS[option]
                const text = visibilityLabel(t, option)

                return (
                  <DropdownMenuRadioItem key={option} value={option}>
                    <Icon aria-hidden="true" className="size-4" />
                    <span className="grid">
                      <span>{text.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {option === "link" && current !== "link"
                          ? t.visibilityLinkUseShare
                          : text.hint}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                )
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={Boolean(confirmTarget)}
        onOpenChange={(open) => !open && setConfirmTarget(undefined)}
        title={t.visibilityLeaveLinkTitle}
        description={t.visibilityLeaveLinkDescription}
        confirmLabel={t.visibilityConfirm}
        cancelLabel={t.cancel}
        onConfirm={() => (confirmTarget ? apply(confirmTarget) : undefined)}
      />
    </>
  )
}
