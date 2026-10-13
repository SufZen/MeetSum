"use client"

/**
 * Follow-up email draft (M5 D5): Hebrew or English, formal/friendly/concise,
 * optional action-item list. Copy always works; `mailto:` only while the body
 * fits a mail link (≤ 1800 characters). Sending is M8.
 */
import { useMemo, useState } from "react"
import { CopyIcon, MailIcon, RefreshCwIcon } from "lucide-react"

import { ApiError, requestJson, useJson } from "@/components/intelligence/use-json"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { CitedMark } from "@/components/ui/meeting-atoms"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { FollowUpTone, FollowUpVariant } from "@/lib/intelligence/follow-up"

export type FollowUpPanelProps = {
  meetingId: string
  dictionary: Dictionary
  /** Legacy `followUpDraft` shown until an email is generated. */
  draft?: string
  /** Default email language (meeting language). */
  defaultLanguage?: "he" | "en"
  onCopyText?: (text: string, label: string) => void
  /** `meeting:write`: may regenerate (overwrite) a shared cached draft. */
  canWrite?: boolean
}

const MAILTO_MAX_BODY_CHARS = 1800

export function FollowUpPanel({
  meetingId,
  dictionary: t,
  draft,
  defaultLanguage = "he",
  onCopyText,
  canWrite = false,
}: FollowUpPanelProps) {
  const url = `/api/meetings/${encodeURIComponent(meetingId)}/follow-up`
  const [includeActionItems, setIncludeActionItems] = useState(true)
  // The action-item list is applied per response, so toggling it refetches.
  const { data, setData } = useJson<{ variants: FollowUpVariant[] }>(
    `${url}?includeActionItems=${includeActionItems ? "1" : "0"}`
  )
  const [language, setLanguage] = useState<"he" | "en">(defaultLanguage)
  const [tone, setTone] = useState<FollowUpTone>("formal")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const variant = useMemo(
    () => data?.variants.find((item) => item.variant === `${language}:${tone}`),
    [data?.variants, language, tone]
  )
  const dir = language === "he" ? "rtl" : "ltr"
  const fullText = variant ? `${variant.subject}\n\n${variant.bodyText}` : ""
  const mailto =
    variant && variant.bodyText.length <= MAILTO_MAX_BODY_CHARS
      ? `mailto:?subject=${encodeURIComponent(variant.subject)}&body=${encodeURIComponent(variant.bodyText)}`
      : undefined

  async function generate() {
    setBusy(true)
    setMessage(undefined)
    try {
      const body = await requestJson<{ variant: FollowUpVariant }>(url, {
        method: "POST",
        body: { language, tone, includeActionItems, ...(variant && canWrite ? { force: true } : {}) },
      })

      setData((previous) => ({
        variants: [...(previous?.variants ?? []).filter((item) => item.variant !== body.variant.variant), body.variant],
      }))
    } catch (caught) {
      setMessage(
        caught instanceof ApiError && caught.code === "summary_required"
          ? t.intelFollowUpNeedsSummary
          : caught instanceof ApiError && caught.code === "llm_not_configured"
            ? t.intelLlmNotConfigured
            : t.intelLlmFailed
      )
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (onCopyText) {
      onCopyText(fullText, t.intelFollowUpEmail)
      return
    }
    try {
      await navigator.clipboard.writeText(fullText)
      setMessage(t.intelCopied)
    } catch {
      setMessage(t.intelLoadFailed)
    }
  }

  return (
    <section className="ms-card mx-auto grid max-w-3xl gap-4 p-4" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t.intelFollowUpEmail}</h3>
        {!variant || canWrite ? (
          <Button size="sm" variant="ai" disabled={busy} onClick={() => void generate()}>
            <RefreshCwIcon data-icon="inline-start" className="size-4" />
            {busy ? t.intelGenerating : variant ? t.intelRegenerate : t.intelFollowUpGenerate}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          aria-label={t.intelLanguage}
          value={[language]}
          onValueChange={(value: string[]) => value[0] && setLanguage(value[0] as "he" | "en")}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="he">{t.intelLanguageHe}</ToggleGroupItem>
          <ToggleGroupItem value="en">{t.intelLanguageEn}</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup
          aria-label={t.intelTone}
          value={[tone]}
          onValueChange={(value: string[]) => value[0] && setTone(value[0] as FollowUpTone)}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="formal">{t.intelToneFormal}</ToggleGroupItem>
          <ToggleGroupItem value="friendly">{t.intelToneFriendly}</ToggleGroupItem>
          <ToggleGroupItem value="concise">{t.intelToneConcise}</ToggleGroupItem>
        </ToggleGroup>
        <label className="inline-flex items-center gap-2 text-sm">
          <Checkbox checked={includeActionItems} onCheckedChange={(checked) => setIncludeActionItems(checked === true)} />
          {t.intelIncludeTasks}
        </label>
      </div>

      {message ? (
        <p role="status" className="text-sm text-fg-2">
          {message}
        </p>
      ) : null}

      {variant ? (
        <div className="grid gap-2" dir={dir}>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-ai-text">
            <CitedMark className="size-3.5" />
            {t.intelAiLabel}
          </span>
          <div className="text-sm">
            <span className="text-fg-3">{t.intelSubject}: </span>
            <span className="font-medium">{variant.subject}</span>
          </div>
          <pre className="whitespace-pre-wrap rounded-md bg-surface-2 p-3 font-sans text-md leading-7 text-fg">
            {variant.bodyText}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              <CopyIcon data-icon="inline-start" className="size-4" />
              {t.intelCopyEmail}
            </Button>
            {mailto ? (
              <Button size="sm" variant="ghost" render={<a href={mailto} />}>
                <MailIcon data-icon="inline-start" className="size-4" />
                {t.intelOpenInMail}
              </Button>
            ) : (
              <span className="text-xs text-fg-3">{t.intelMailtoTooLong}</span>
            )}
          </div>
        </div>
      ) : draft ? (
        <p className="whitespace-pre-wrap text-sm leading-6 text-fg-2">{draft}</p>
      ) : null}
    </section>
  )
}
