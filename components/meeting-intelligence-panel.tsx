import { ActivityIcon, FileAudioIcon } from "lucide-react"

import { ActionItemList } from "@/components/action-item-list"
import { TagList } from "@/components/tag-list"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { MeetingRecord } from "@/lib/meetings/repository"
import { GOOGLE_WORKSPACE_SCOPES } from "@/lib/google/workspace"

export function MeetingIntelligencePanel({
  dictionary,
  meeting,
  totalActionItems,
  onToggleActionItem,
  onExportRealizeOS,
  exporting,
}: {
  dictionary: Dictionary
  meeting: MeetingRecord | null
  totalActionItems: number
  onToggleActionItem?: Parameters<typeof ActionItemList>[0]["onToggle"]
  onExportRealizeOS?: () => void
  exporting?: boolean
}) {
  return (
    <div className="grid gap-5">
      <section>
        <h3 className="mb-3 text-sm font-semibold">{dictionary.pipeline}</h3>
        <div className="grid gap-2">
          {["media_uploaded", "transcribing", "summarizing", "indexing"].map(
            (status) => (
              <div
                key={status}
                className="flex min-h-11 items-center justify-between gap-3 rounded-md border p-3 text-sm"
              >
                <span>{status.replaceAll("_", " ")}</span>
                <ActivityIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              </div>
            )
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold">{dictionary.tags}</h3>
        <TagList tags={meeting?.tags} />
        {meeting?.languageMetadata && (
          <div className="mt-3 rounded-md border bg-card p-3 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">{dictionary.language}</div>
            <div>
              {meeting.languageMetadata.primaryLanguage}
              {meeting.languageMetadata.mixedLanguage
                ? ` · ${dictionary.mixedLanguage}`
                : ""}
            </div>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold">{dictionary.actionItems}</h3>
        <ActionItemList
          items={meeting?.intelligence?.actionItems ?? meeting?.summary?.actionItems}
          unassigned={dictionary.unassigned}
          onToggle={onToggleActionItem}
        />
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold">{dictionary.integrations}</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Badge variant="secondary" className="h-7 justify-center rounded-sm">
            n8n
          </Badge>
          <Badge variant="secondary" className="h-7 justify-center rounded-sm">
            MCP
          </Badge>
          <Badge variant="secondary" className="h-7 justify-center rounded-sm">
            CLI
          </Badge>
          <Badge variant="secondary" className="h-7 justify-center rounded-sm">
            REST
          </Badge>
        </div>
        <Button
          size="sm"
          className="mt-3 w-full"
          disabled={!meeting || exporting}
          onClick={onExportRealizeOS}
        >
          {exporting ? "Exporting..." : "Export to RealizeOS"}
        </Button>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {totalActionItems} open action items can trigger agents, webhooks,
          RealizeOS context packets, or follow-up drafts.
        </p>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold">Google scopes</h3>
        <div className="grid gap-2 text-sm">
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
        <h3 className="mb-3 text-sm font-semibold">{dictionary.storagePolicy}</h3>
        <div className="flex min-h-16 items-center gap-3 rounded-md border p-3">
          <FileAudioIcon aria-hidden="true" className="size-5 text-muted-foreground" />
          <div>
            <div className="text-sm font-medium">{dictionary.audioFirst}</div>
            <div className="text-xs text-muted-foreground">
              {dictionary.videoRetained}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
