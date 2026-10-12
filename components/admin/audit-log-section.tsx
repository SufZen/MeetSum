"use client"

import { Loader2Icon, SearchIcon } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"

import {
  listAuditLogs,
  type AuditLogFilters,
  type AuditLogView,
} from "@/components/admin/api"
import { formatDateTime } from "@/components/admin/labels"
import { SectionState } from "@/components/admin/section-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"

/** Common actions offered in the filter (free text is not needed). */
const ACTION_OPTIONS = [
  "meeting.created",
  "meeting.deleted",
  "meeting.visibility.changed",
  "meeting.share.created",
  "meeting.share.updated",
  "meeting.share.accessed",
  "meeting.export.markdown",
  "meeting.export.pdf",
  "member.role_changed",
  "member.removed",
  "member.left",
  "invitation.created",
  "invitation.resent",
  "invitation.revoked",
  "invitation.accepted",
  "api_key.created",
  "api_key.revoked",
  "admin.settings.updated",
  "workspace.created",
  "workspace.updated",
  "auth.login.denied",
  "webhook.subscription.created",
  "webhook.subscription.updated",
  "media.retention.deleted",
] as const

const EMPTY_FILTERS: AuditLogFilters = { action: "", actor: "", targetId: "" }

export function AuditLogSection({
  dictionary: t,
  locale,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
}) {
  const [draft, setDraft] = useState<AuditLogFilters>(EMPTY_FILTERS)
  const [logs, setLogs] = useState<AuditLogView[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string>()
  const appliedRef = useRef<AuditLogFilters>(EMPTY_FILTERS)

  const load = useCallback(async (filters: AuditLogFilters) => {
    appliedRef.current = filters
    setLoading(true)
    setError(undefined)
    try {
      const page = await listAuditLogs(filters)

      setLogs(page.logs)
      setNextCursor(page.nextCursor)
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError)
      )
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial page (state already starts as loading).
  useEffect(() => {
    let cancelled = false

    listAuditLogs(EMPTY_FILTERS).then(
      (page) => {
        if (cancelled) return
        setLogs(page.logs)
        setNextCursor(page.nextCursor)
        setLoading(false)
      },
      (loadError: unknown) => {
        if (cancelled) return
        setError(
          loadError instanceof Error ? loadError.message : String(loadError)
        )
        setLoading(false)
      }
    )

    return () => {
      cancelled = true
    }
  }, [])

  async function loadMore() {
    if (!nextCursor) return

    setLoadingMore(true)
    try {
      const page = await listAuditLogs(appliedRef.current, nextCursor)

      setLogs((current) => [...current, ...page.logs])
      setNextCursor(page.nextCursor)
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError)
      )
    } finally {
      setLoadingMore(false)
    }
  }

  function apply(event: FormEvent) {
    event.preventDefault()
    void load(draft)
  }

  function clear() {
    setDraft(EMPTY_FILTERS)
    void load(EMPTY_FILTERS)
  }

  return (
    <div className="grid gap-3">
      <form
        onSubmit={apply}
        className="grid gap-3 rounded-lg border border-line bg-surface-2 p-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="audit-action">{t.auditFilterAction}</Label>
          <NativeSelect
            id="audit-action"
            value={draft.action ?? ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                action: event.target.value,
              }))
            }
          >
            <NativeSelectOption value="">{t.all}</NativeSelectOption>
            {ACTION_OPTIONS.map((action) => (
              <NativeSelectOption key={action} value={action}>
                {action}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-actor">{t.auditFilterActor}</Label>
          <Input
            id="audit-actor"
            dir="ltr"
            value={draft.actor ?? ""}
            onChange={(event) =>
              setDraft((current) => ({ ...current, actor: event.target.value }))
            }
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-target">{t.auditFilterTarget}</Label>
          <Input
            id="audit-target"
            dir="ltr"
            value={draft.targetId ?? ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                targetId: event.target.value,
              }))
            }
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={loading}>
            <SearchIcon data-icon="inline-start" />
            {t.auditApply}
          </Button>
          <Button type="button" variant="ghost" onClick={clear}>
            {t.auditClear}
          </Button>
        </div>
      </form>

      <SectionState
        loading={loading}
        error={error}
        empty={logs.length === 0}
        emptyLabel={t.auditEmpty}
        loadingLabel={t.workspaceLoading}
        retryLabel={t.retry}
        onRetry={() => void load(appliedRef.current)}
      >
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="bg-surface-2 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-start font-medium">
                  {t.auditColumnTime}
                </th>
                <th className="px-3 py-2 text-start font-medium">
                  {t.auditColumnAction}
                </th>
                <th className="px-3 py-2 text-start font-medium">
                  {t.auditColumnActor}
                </th>
                <th className="px-3 py-2 text-start font-medium">
                  {t.auditColumnTarget}
                </th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr
                  key={log.id}
                  className="border-t border-line align-top"
                >
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                    {formatDateTime(locale, log.createdAt, {
                      dateStyle: "short",
                      timeStyle: "medium",
                    })}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs" dir="ltr">
                    {log.action}
                  </td>
                  <td className="px-3 py-2" dir="auto">
                    <bdi>{log.actor ?? t.auditSystemActor}</bdi>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {log.targetType || log.targetId ? (
                      <bdi>
                        {[log.targetType, log.targetId]
                          .filter(Boolean)
                          .join(" · ")}
                      </bdi>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {nextCursor ? (
          <div className="mt-3 flex justify-center">
            <Button
              variant="outline"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? (
                <Loader2Icon
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : null}
              {t.auditLoadMore}
            </Button>
          </div>
        ) : null}
      </SectionState>
    </div>
  )
}
