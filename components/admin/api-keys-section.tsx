"use client"

import { CopyIcon, KeyRoundIcon, TriangleAlertIcon } from "lucide-react"
import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  scopeLevel,
  type ApiKeyScopeName,
  type ApiKeyView,
} from "@/components/admin/api"
import { ConfirmDialog } from "@/components/admin/confirm-dialog"
import { formatDateTime, scopeLabel } from "@/components/admin/labels"
import { SectionState } from "@/components/admin/section-state"
import { useAsyncResource } from "@/components/admin/use-async-resource"
import { Badge } from "@/components/ui/badge"
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
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"

const SCOPES: ApiKeyScopeName[] = ["read", "write", "admin"]

export function ApiKeysSection({
  dictionary: t,
  locale,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
}) {
  const keys = useAsyncResource(listApiKeys, [] as ApiKeyView[])
  const [createOpen, setCreateOpen] = useState(false)
  const [label, setLabel] = useState("")
  const [scope, setScope] = useState<ApiKeyScopeName>("read")
  const [expiresAt, setExpiresAt] = useState("")
  const [creating, setCreating] = useState(false)
  const [rawKey, setRawKey] = useState<string>()
  const [revoking, setRevoking] = useState<ApiKeyView>()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setCreating(true)
    try {
      const created = await createApiKey({
        label: label.trim(),
        scope,
        expiresAt: expiresAt
          ? new Date(`${expiresAt}T23:59:59`).toISOString()
          : null,
      })

      if (created.record.id) {
        keys.setData((current) => [created.record, ...current])
      } else {
        await keys.reload()
      }

      setCreateOpen(false)
      setLabel("")
      setScope("read")
      setExpiresAt("")
      setRawKey(created.rawKey)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.actionFailed)
    } finally {
      setCreating(false)
    }
  }

  async function copyKey() {
    if (!rawKey) return

    try {
      await navigator.clipboard.writeText(rawKey)
      toast.success(t.apiKeysCopied)
    } catch {
      toast.error(t.actionFailed)
    }
  }

  async function confirmRevoke(key: ApiKeyView) {
    try {
      await revokeApiKey(key.id)
      keys.setData((current) =>
        current.map((item) =>
          item.id === key.id
            ? { ...item, revokedAt: new Date().toISOString() }
            : item
        )
      )
      toast.success(t.apiKeysRevoked)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.actionFailed)
      throw error
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>
          <KeyRoundIcon data-icon="inline-start" />
          {t.apiKeysCreate}
        </Button>
      </div>

      <SectionState
        loading={keys.loading}
        error={keys.error}
        empty={keys.data.length === 0}
        emptyLabel={t.apiKeysEmpty}
        loadingLabel={t.workspaceLoading}
        retryLabel={t.retry}
        onRetry={() => void keys.reload()}
      >
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-surface-2 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-start font-medium">
                  {t.apiKeysColumnKey}
                </th>
                <th className="px-3 py-2 text-start font-medium">
                  {t.apiKeysScope}
                </th>
                <th className="px-3 py-2 text-start font-medium">
                  {t.apiKeysColumnLastUsed}
                </th>
                <th className="px-3 py-2 text-start font-medium">
                  {t.apiKeysColumnCreated}
                </th>
                <th className="px-3 py-2 text-end font-medium">
                  {t.columnActions}
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.data.map((key) => (
                <tr
                  key={key.id}
                  className="border-t border-line align-middle"
                >
                  <td className="px-3 py-2">
                    <div className="font-medium">
                      <bdi>{key.label || "—"}</bdi>
                    </div>
                    <div
                      className="font-mono text-xs text-muted-foreground"
                      dir="ltr"
                    >
                      {key.keyPrefix}…
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary">
                      {scopeLabel(t, scopeLevel(key.scopes))}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {key.lastUsedAt
                      ? formatDateTime(locale, key.lastUsedAt)
                      : t.apiKeysNever}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatDateTime(locale, key.createdAt, {
                      dateStyle: "medium",
                    })}
                  </td>
                  <td className="px-3 py-2 text-end">
                    {key.revokedAt ? (
                      <Badge variant="outline">{t.apiKeysRevokedBadge}</Badge>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setRevoking(key)}
                      >
                        {t.apiKeysRevoke}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionState>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{t.apiKeysCreate}</DialogTitle>
              <DialogDescription>
                {t.apiKeysCreateDescription}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="api-key-label">{t.apiKeysLabel}</Label>
              <Input
                id="api-key-label"
                dir="auto"
                maxLength={80}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="api-key-scope">{t.apiKeysScope}</Label>
              <NativeSelect
                id="api-key-scope"
                value={scope}
                onChange={(event) =>
                  setScope(event.target.value as ApiKeyScopeName)
                }
              >
                {SCOPES.map((option) => (
                  <NativeSelectOption key={option} value={option}>
                    {scopeLabel(t, option)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="api-key-expires">{t.apiKeysExpires}</Label>
              <Input
                id="api-key-expires"
                type="date"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
              >
                {t.cancel}
              </Button>
              <Button type="submit" disabled={creating}>
                {t.apiKeysCreate}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(rawKey)}
        onOpenChange={(open) => !open && setRawKey(undefined)}
      >
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t.apiKeysCreatedTitle}</DialogTitle>
            <DialogDescription className="flex items-start gap-2">
              <TriangleAlertIcon
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-warn-text"
              />
              {t.apiKeysCreatedDescription}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              dir="ltr"
              className="font-mono text-xs"
              value={rawKey ?? ""}
              onFocus={(event) => event.currentTarget.select()}
              aria-label={t.apiKeysColumnKey}
            />
            <Button variant="outline" onClick={() => void copyKey()}>
              <CopyIcon data-icon="inline-start" />
              {t.apiKeysCopy}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setRawKey(undefined)}>{t.done}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(undefined)}
        title={formatMessage(t.apiKeysRevokeTitle, {
          label: revoking?.label || revoking?.keyPrefix || "",
        })}
        description={t.apiKeysRevokeDescription}
        confirmLabel={t.apiKeysRevoke}
        cancelLabel={t.cancel}
        onConfirm={() => (revoking ? confirmRevoke(revoking) : undefined)}
      />
    </div>
  )
}
