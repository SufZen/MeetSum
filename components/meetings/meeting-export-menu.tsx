"use client"

import { FileTextIcon, NotepadTextIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { downloadExport } from "@/lib/client/download-export"
import type { MeetingVisibility } from "@/lib/meetings/repository"

/**
 * Meeting export menu (owner: Package C; docs/parity/m8.md, C3). Mounted
 * in the right rail's export block in M8 Step 0.
 *
 * Step 0 stub: renders today's two actions (PDF, Markdown) unchanged.
 * Package C turns it into the Download / Google Docs / Send to… menu.
 */
export function MeetingExportMenu({
  meetingId,
  title,
  language,
  visibility,
  canManage,
}: {
  /** Undefined while no meeting is selected (actions disabled). */
  meetingId: string | undefined
  title: string
  language: string
  visibility: MeetingVisibility | undefined
  /** `canManageMeeting`: gates "Send to…" on private meetings (Package C). */
  canManage: boolean
}) {
  void language
  void visibility
  void canManage

  const actions = [
    { Icon: FileTextIcon, label: "PDF", format: "pdf" as const },
    { Icon: NotepadTextIcon, label: "MD", format: "markdown" as const },
  ]

  return (
    <>
      {actions.map(({ Icon, label, format }) => (
        <Button
          key={label}
          variant="outline"
          size="icon"
          className="size-9 rounded-md"
          onClick={meetingId ? () => void downloadExport({ id: meetingId, title }, format) : undefined}
          disabled={!meetingId}
          title={meetingId ? label : `${label} is not available yet`}
        >
          <Icon aria-hidden="true" className="size-4" />
        </Button>
      ))}
    </>
  )
}
