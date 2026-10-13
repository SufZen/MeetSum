"use client"

import { useEffect, useMemo, useState } from "react"
import { BotIcon, ScaleIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { BdiMessage } from "@/components/bot/bdi-message"
import { botApi } from "@/components/bot/bot-api"
import {
  LEAD_MAX,
  LEAD_MIN,
  LEAD_STEP,
  BOT_NAME_MAX,
  CONSENT_MAX,
  addDomainChip,
  botNamePreview,
  buildBotRulesPatch,
  clampLead,
  draftFromRules,
  parseSkipPatterns,
  validateBotRulesDraft,
  type BotRulesDraft,
} from "@/components/bot/bot-rules-state"
import { useWorkspace } from "@/components/workspace-context"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import type { BotSettingsResponse, BotStatusResponse } from "@/lib/bot/api-types"
import { BOT_AUTO_JOIN_MODES, type BotAutoJoinMode, type BotRules } from "@/lib/bot/types"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"
import type { BotMessageKey } from "@/lib/i18n/m7/bot"
import { cn } from "@/lib/utils"

const AUTO_JOIN_COPY: Record<BotAutoJoinMode, [BotMessageKey, BotMessageKey]> = {
  off: ["botAutoJoinOff", "botAutoJoinOffHint"],
  all: ["botAutoJoinAll", "botAutoJoinAllHint"],
  external_only: ["botAutoJoinExternal", "botAutoJoinExternalHint"],
  owner_only: ["botAutoJoinOwner", "botAutoJoinOwnerHint"],
}

type Loaded = Extract<BotSettingsResponse, { enabled: true }>

/**
 * Bot rules (M7 C3, Settings → Live meeting). Editable with settings:write,
 * read-only otherwise. Auto-join stays off until an admin ticks the
 * recording-consent acknowledgment next to the legal note.
 */
export function BotRulesSettings({ dictionary }: { dictionary: Dictionary }) {
  const { can, activeWorkspace } = useWorkspace()
  const canReadOps = can("ops:read")
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "disabled" } | { kind: "error" } | { kind: "ready"; data: Loaded }
  >({ kind: "loading" })
  const [draft, setDraft] = useState<BotRulesDraft | null>(null)
  const [skipText, setSkipText] = useState("")
  const [domainInput, setDomainInput] = useState("")
  const [ackNow, setAckNow] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<BotStatusResponse | null>(null)
  const workspaceId = activeWorkspace?.id

  useEffect(() => {
    let cancelled = false

    void botApi.settings().then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setState(result.status === 404 ? { kind: "disabled" } : { kind: "error" })
        return
      }
      if (!result.body.enabled) {
        setState({ kind: "disabled" })
        return
      }
      setState({ kind: "ready", data: result.body })
      setDraft(draftFromRules(result.body.rules))
      setSkipText(result.body.rules.skipTitlePatterns.join("\n"))
      setAckNow(false)
    })

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  useEffect(() => {
    if (!canReadOps || state.kind !== "ready") return

    let cancelled = false

    void botApi.status().then((result) => {
      if (!cancelled && result.ok) setStatus(result.body)
    })

    return () => {
      cancelled = true
    }
  }, [canReadOps, state.kind])

  const saved: BotRules | null = state.kind === "ready" ? state.data.rules : null
  const acknowledged = Boolean(saved?.consentAcknowledgedAt) || ackNow
  const errors = useMemo(
    () => (draft ? validateBotRulesDraft(draft, acknowledged) : {}),
    [acknowledged, draft]
  )

  if (state.kind === "loading") {
    return <div aria-busy="true" className="ms-card h-48 animate-pulse bg-surface-2" />
  }
  if (state.kind === "disabled" || state.kind === "error") {
    return (
      <section className="ms-card flex items-center gap-2 p-4 text-sm text-fg-3">
        <BotIcon aria-hidden="true" className="size-4 shrink-0" />
        {state.kind === "disabled" ? dictionary.botSettingsDisabled : dictionary.botSettingsLoadFailed}
      </section>
    )
  }
  if (!draft || !saved) return null

  const editable = state.data.editable
  const update = (patch: Partial<BotRulesDraft>) => setDraft({ ...draft, ...patch })
  const hasErrors = Object.keys(errors).length > 0
  const patch = buildBotRulesPatch(saved, draft, ackNow)
  const dirty = Object.keys(patch).length > 0

  const save = async () => {
    if (!editable || hasErrors || !dirty) return
    setSaving(true)

    const result = await botApi.updateSettings(patch)

    setSaving(false)
    if (!result.ok) {
      toast.error(dictionary[result.error])
      return
    }
    setState({ kind: "ready", data: { ...state.data, rules: result.body.rules } })
    setDraft(draftFromRules(result.body.rules))
    setSkipText(result.body.rules.skipTitlePatterns.join("\n"))
    setAckNow(false)
    toast.success(dictionary.botSettingsSaved)
  }

  return (
    <section className="ms-card grid gap-5 p-4">
      <header className="grid gap-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <BotIcon aria-hidden="true" className="size-4" />
          {dictionary.botSettingsTitle}
        </h2>
        <p className="text-sm text-fg-3">
          <BdiMessage template={dictionary.botSettingsDescription} values={{ name: saved.botName }} />
        </p>
        {!editable ? <p className="text-sm text-fg-3">{dictionary.botSettingsReadOnly}</p> : null}
      </header>

      {status ? (
        <div className="grid gap-1 rounded-lg bg-surface-2 p-3 text-sm">
          <span className="font-medium">{dictionary.botStatusTitle}</span>
          <span className={status.healthy ? "text-ok-text" : "text-danger-text"}>
            {status.healthy ? dictionary.botStatusHealthy : dictionary.botStatusUnhealthy}
            {" · "}
            <bdi>{formatMessage(dictionary.botStatusVersion, { version: status.vexaVersion })}</bdi>
          </span>
          <span className="text-fg-3">
            {formatMessage(dictionary.botStatusRunning, {
              running: status.running,
              max: status.capacity.max,
            })}
          </span>
          <span className={status.webhookConfigured ? "text-fg-3" : "text-warn-text"}>
            {status.webhookConfigured ? dictionary.botStatusWebhook : dictionary.botStatusWebhookMissing}
          </span>
        </div>
      ) : null}

      <fieldset className="grid gap-2" disabled={!editable}>
        <legend className="mb-2 text-sm font-medium">{dictionary.botAutoJoinLabel}</legend>
        {BOT_AUTO_JOIN_MODES.map((mode) => {
          const [label, hint] = AUTO_JOIN_COPY[mode]
          const locked = mode !== "off" && !acknowledged

          return (
            <label
              key={mode}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-lg border border-line p-3 has-checked:border-brand has-checked:bg-brand-soft",
                locked && "cursor-not-allowed opacity-60"
              )}
            >
              <input
                type="radio"
                name="bot-auto-join"
                value={mode}
                className="mt-1 accent-brand"
                checked={draft.autoJoin === mode}
                disabled={!editable || locked}
                onChange={() => update({ autoJoin: mode })}
              />
              <span className="grid">
                <span className="text-sm font-medium">{dictionary[label]}</span>
                <span className="text-xs text-fg-3">{dictionary[hint]}</span>
              </span>
            </label>
          )
        })}
        {errors.autoJoin || (!acknowledged && editable) ? (
          <p className="text-xs text-warn-text">{dictionary.botConsentAckRequired}</p>
        ) : null}
      </fieldset>

      <div className="grid gap-2 rounded-lg border border-line p-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ScaleIcon aria-hidden="true" className="size-4" />
          {dictionary.botLegalTitle}
        </h3>
        <p className="text-sm leading-6 text-fg-2">{dictionary.botLegalBody}</p>
        {saved.consentAcknowledgedAt ? (
          <p className="text-sm text-ok-text">{dictionary.botConsentAckDone}</p>
        ) : (
          <label className="flex items-start gap-2.5 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={ackNow}
              disabled={!editable}
              onCheckedChange={(checked) => setAckNow(Boolean(checked))}
            />
            {dictionary.botConsentAck}
          </label>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-1.5 text-sm font-medium">
          {dictionary.botLeadLabel}
          <span className="flex items-center gap-3">
            <input
              type="range"
              min={LEAD_MIN}
              max={LEAD_MAX}
              step={LEAD_STEP}
              value={draft.joinLeadSeconds}
              disabled={!editable}
              className="flex-1 accent-brand"
              onChange={(event) => update({ joinLeadSeconds: clampLead(Number(event.target.value)) })}
            />
            <span className="w-14 shrink-0 text-end font-mono text-sm tabular-nums [unicode-bidi:isolate]">
              {formatMessage(dictionary.botLeadValue, { seconds: draft.joinLeadSeconds })}
            </span>
          </span>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          {dictionary.botMinAttendees}
          <Input
            type="number"
            min={1}
            max={50}
            value={draft.minAttendees}
            disabled={!editable}
            onChange={(event) =>
              update({ minAttendees: Math.min(50, Math.max(1, Number(event.target.value) || 1)) })
            }
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          {dictionary.botNameLabel}
          <Input
            dir="auto"
            maxLength={BOT_NAME_MAX}
            value={draft.botName}
            disabled={!editable}
            aria-invalid={Boolean(errors.botName) || undefined}
            onChange={(event) => update({ botName: event.target.value })}
          />
          <span className="text-xs font-normal text-fg-3">
            {dictionary.botNamePreview}: <bdi>{botNamePreview(draft.botName, dictionary.botRecordingSuffix)}</bdi>
          </span>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          {dictionary.botLanguageMode}
          <NativeSelect
            value={draft.languageMode}
            disabled={!editable}
            onChange={(event) =>
              update({ languageMode: event.target.value as BotRulesDraft["languageMode"] })
            }
          >
            <NativeSelectOption value="meeting">{dictionary.botLanguageModeMeeting}</NativeSelectOption>
            <NativeSelectOption value="he">{dictionary.botJoinLanguageHe}</NativeSelectOption>
            <NativeSelectOption value="en">{dictionary.botJoinLanguageEn}</NativeSelectOption>
            <NativeSelectOption value="auto">{dictionary.botJoinLanguageAuto}</NativeSelectOption>
          </NativeSelect>
        </label>
      </div>

      <div className="grid gap-3">
        <label className="flex items-start gap-2.5 text-sm font-medium">
          <Checkbox
            className="mt-0.5"
            checked={draft.consentEnabled}
            disabled={!editable}
            onCheckedChange={(checked) => update({ consentEnabled: Boolean(checked) })}
          />
          {dictionary.botConsentEnabled}
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">
            {dictionary.botConsentHe}
            <Textarea
              dir="rtl"
              lang="he"
              rows={4}
              maxLength={CONSENT_MAX}
              value={draft.consentMessage.he}
              disabled={!editable || !draft.consentEnabled}
              aria-invalid={Boolean(errors.consentHe) || undefined}
              onChange={(event) =>
                update({ consentMessage: { ...draft.consentMessage, he: event.target.value } })
              }
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            {dictionary.botConsentEn}
            <Textarea
              dir="ltr"
              lang="en"
              rows={4}
              maxLength={CONSENT_MAX}
              value={draft.consentMessage.en}
              disabled={!editable || !draft.consentEnabled}
              aria-invalid={Boolean(errors.consentEn) || undefined}
              onChange={(event) =>
                update({ consentMessage: { ...draft.consentMessage, en: event.target.value } })
              }
            />
          </label>
        </div>
        <p className="text-xs text-fg-3">
          <BdiMessage template={dictionary.botConsentOwnerHint} values={{ owner: "{owner}" }} />
        </p>
      </div>

      <div className="grid gap-2">
        <span className="text-sm font-medium">{dictionary.botInternalDomains}</span>
        <span className="text-xs text-fg-3">{dictionary.botInternalDomainsHint}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {draft.internalDomains.map((domain) => (
            <span
              key={domain}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-3 ps-2.5 pe-1 text-xs"
            >
              <bdi>{domain}</bdi>
              {editable ? (
                <button
                  type="button"
                  className="grid size-5 place-items-center rounded-full hover:bg-surface-4 focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
                  aria-label={formatMessage(dictionary.botInternalDomainsRemove, { domain })}
                  onClick={() =>
                    update({ internalDomains: draft.internalDomains.filter((item) => item !== domain) })
                  }
                >
                  <XIcon aria-hidden="true" className="size-3" />
                </button>
              ) : null}
            </span>
          ))}
          {state.data.envInternalDomains.map((domain) => (
            <span
              key={`env:${domain}`}
              title={dictionary.botInternalDomainsEnv}
              className="inline-flex h-7 items-center rounded-full border border-dashed border-line-strong px-2.5 text-xs text-fg-3"
            >
              <bdi>{domain}</bdi>
            </span>
          ))}
        </div>
        {editable ? (
          <form
            className="flex max-w-sm gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              update({ internalDomains: addDomainChip(draft.internalDomains, domainInput) })
              setDomainInput("")
            }}
          >
            <Input
              dir="ltr"
              value={domainInput}
              placeholder={dictionary.botInternalDomainsPlaceholder}
              aria-label={dictionary.botInternalDomains}
              onChange={(event) => setDomainInput(event.target.value)}
            />
            <Button type="submit" variant="secondary">
              {dictionary.botInternalDomainsAdd}
            </Button>
          </form>
        ) : null}
      </div>

      <label className="grid gap-1.5 text-sm font-medium">
        {dictionary.botSkipPatterns}
        <Textarea
          dir="auto"
          rows={3}
          value={skipText}
          disabled={!editable}
          onChange={(event) => {
            setSkipText(event.target.value)
            update({ skipTitlePatterns: parseSkipPatterns(event.target.value) })
          }}
        />
        <span className="text-xs font-normal text-fg-3">{dictionary.botSkipPatternsHint}</span>
      </label>

      {editable ? (
        <div className="flex items-center gap-3">
          <Button disabled={saving || hasErrors || !dirty} onClick={() => void save()}>
            {saving ? dictionary.botSettingsSaving : dictionary.botSettingsSave}
          </Button>
          {hasErrors && !errors.autoJoin ? (
            <span className="text-xs text-danger-text">{dictionary.botFieldInvalid}</span>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
