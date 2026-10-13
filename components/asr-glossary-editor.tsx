"use client"

import { useEffect, useMemo, useState } from "react"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useWorkspace } from "@/components/workspace-context"
import type { AsrGlossary, AsrHealth, GlossaryTerm } from "@/lib/ai/asr/types"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"

type Limits = { maxTerms: number; maxChars: number; maxAliases: number }

type GlossaryPayload = {
  glossary: AsrGlossary
  defaults: AsrGlossary
  limits: Limits
}

type DraftTerm = { key: string; term: string; aliases: string; hotword: boolean; caseSensitive?: boolean }

type StatusPayload = { chain: string[]; nonHebrewChain: string[]; providers: AsrHealth[] }

const DEFAULT_LIMITS: Limits = { maxTerms: 300, maxChars: 64, maxAliases: 10 }

function sameTerm(a: GlossaryTerm, b: GlossaryTerm) {
  return (
    a.term === b.term &&
    a.hotword === b.hotword &&
    Boolean(a.caseSensitive) === Boolean(b.caseSensitive) &&
    a.aliases.length === b.aliases.length &&
    a.aliases.every((alias, index) => alias === b.aliases[index])
  )
}

/** Workspace terms = effective terms that are not an unchanged built-in. */
export function splitGlossary(glossary: AsrGlossary, defaults: AsrGlossary) {
  const workspace = glossary.terms.filter(
    (term) => !defaults.terms.some((builtIn) => sameTerm(builtIn, term))
  )
  const overridden = new Set(workspace.map((term) => term.term.toLocaleLowerCase()))

  return {
    workspace,
    builtIn: defaults.terms.filter((term) => !overridden.has(term.term.toLocaleLowerCase())),
  }
}

function parseAliases(value: string) {
  return value
    .split(/[,،]/)
    .map((alias) => alias.trim())
    .filter(Boolean)
}

let draftCounter = 0
const draftKey = () => `term-${(draftCounter += 1)}`

function toDraft(term: GlossaryTerm): DraftTerm {
  return {
    key: draftKey(),
    term: term.term,
    aliases: term.aliases.join(", "),
    hotword: term.hotword,
    ...(term.caseSensitive !== undefined ? { caseSensitive: term.caseSensitive } : {}),
  }
}

/** Client-side check of the server limits, with localized messages. */
function validate(drafts: DraftTerm[], limits: Limits, t: Dictionary) {
  const errors = new Map<string, string>()
  const seen = new Set<string>()

  for (const draft of drafts) {
    const term = draft.term.trim()
    const aliases = parseAliases(draft.aliases)

    if (!term) errors.set(draft.key, t.glossaryRequired)
    else if (term.length > limits.maxChars || aliases.some((alias) => alias.length > limits.maxChars)) {
      errors.set(draft.key, formatMessage(t.glossaryTooLong, { max: limits.maxChars }))
    } else if (aliases.length > limits.maxAliases) {
      errors.set(draft.key, formatMessage(t.glossaryTooManyAliases, { max: limits.maxAliases }))
    } else if (seen.has(term.toLocaleLowerCase())) {
      errors.set(draft.key, t.glossaryDuplicate)
    }
    seen.add(term.toLocaleLowerCase())
  }

  return errors
}

/**
 * ASR glossary editor (M3 C6): workspace terms (term, "heard as" aliases,
 * hotword toggle) above the read-only built-in terms, a limit counter and
 * Save → PUT /api/asr/glossary. Admins with ops access also see the ASR
 * provider chain status.
 */
export function AsrGlossaryEditor({ dictionary: t }: { dictionary: Dictionary }) {
  const { can } = useWorkspace()
  const canEdit = can("settings:write")
  const canSeeStatus = can("ops:read")
  const [payload, setPayload] = useState<GlossaryPayload | null>(null)
  const [drafts, setDrafts] = useState<DraftTerm[]>([])
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [serverErrors, setServerErrors] = useState<Map<number, string>>(new Map())
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const response = await fetch("/api/asr/glossary")

        if (!response.ok) throw new Error(String(response.status))

        const body = (await response.json()) as GlossaryPayload

        if (cancelled) return
        setPayload(body)
        setDrafts(splitGlossary(body.glossary, body.defaults).workspace.map(toDraft))
        setLoadError(false)
      } catch {
        if (!cancelled) setLoadError(true)
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const limits = payload?.limits ?? DEFAULT_LIMITS
  const builtIn = useMemo(
    () => (payload ? splitGlossary(payload.glossary, payload.defaults).builtIn : []),
    [payload]
  )
  const errors = useMemo(() => validate(drafts, limits, t), [drafts, limits, t])
  const atLimit = drafts.length >= limits.maxTerms

  function update(key: string, patch: Partial<DraftTerm>) {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)))
    setServerErrors(new Map())
  }

  async function save() {
    if (errors.size) return
    setSaving(true)

    try {
      const response = await fetch("/api/asr/glossary", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          terms: drafts.map((draft) => ({
            term: draft.term.trim(),
            aliases: parseAliases(draft.aliases),
            hotword: draft.hotword,
            ...(draft.caseSensitive !== undefined ? { caseSensitive: draft.caseSensitive } : {}),
          })),
        }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        fieldErrors?: Array<{ path: string; message: string }>
      }

      if (!response.ok) {
        const rows = new Map<number, string>()

        for (const error of body.fieldErrors ?? []) {
          const index = Number(/^terms\.(\d+)/.exec(error.path)?.[1])

          if (Number.isInteger(index)) rows.set(index, error.message)
        }
        setServerErrors(rows)
        toast.error(t.glossarySaveFailed)
        return
      }

      toast.success(t.glossarySaved)
      setReloadKey((value) => value + 1)
    } catch {
      toast.error(t.glossarySaveFailed)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section aria-labelledby="asr-glossary-title" className="ms-card grid gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="asr-glossary-title" className="text-base font-semibold text-fg">
            {t.glossaryTitle}
          </h3>
          <p className="mt-1 max-w-prose text-sm text-fg-3">{t.glossaryDescription}</p>
        </div>
        <span
          className="font-mono text-xs text-fg-3 tabular-nums [direction:ltr] [unicode-bidi:isolate]"
          aria-live="polite"
        >
          {formatMessage(t.glossaryLimit, { count: drafts.length, max: limits.maxTerms })}
        </span>
      </div>

      {loadError ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 p-3 text-sm">
          <span role="alert">{t.glossaryLoadFailed}</span>
          <Button size="sm" variant="secondary" onClick={() => setReloadKey((value) => value + 1)}>
            {t.retry}
          </Button>
        </div>
      ) : !payload ? (
        <div aria-busy="true" className="h-24 animate-pulse rounded-lg bg-surface-2 motion-reduce:animate-none" />
      ) : (
        <>
          {!canEdit ? <p className="text-sm text-fg-3">{t.glossaryReadOnly}</p> : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/3">{t.glossaryTerm}</TableHead>
                <TableHead>
                  {t.glossaryAliases}
                  <span className="ms-1 font-normal text-fg-3">({t.glossaryAliasesHint})</span>
                </TableHead>
                <TableHead className="w-24">{t.glossaryHotword}</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">{t.columnActions}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drafts.length ? null : (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-fg-3">
                    {t.glossaryEmpty}
                  </TableCell>
                </TableRow>
              )}
              {drafts.map((draft, index) => {
                const error = errors.get(draft.key) ??
                  (serverErrors.has(index)
                    ? formatMessage(t.glossaryServerError, { message: serverErrors.get(index) ?? "" })
                    : undefined)
                const errorId = `${draft.key}-error`

                return (
                  <TableRow key={draft.key}>
                    <TableCell className="align-top">
                      <Input
                        dir="auto"
                        value={draft.term}
                        disabled={!canEdit}
                        maxLength={limits.maxChars + 10}
                        aria-label={t.glossaryTerm}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? errorId : undefined}
                        onChange={(event) => update(draft.key, { term: event.target.value })}
                      />
                      {error ? (
                        <p id={errorId} className="mt-1 text-xs text-danger-text">
                          {error}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top">
                      <Input
                        dir="auto"
                        value={draft.aliases}
                        disabled={!canEdit}
                        aria-label={`${t.glossaryAliases} (${t.glossaryAliasesHint})`}
                        onChange={(event) => update(draft.key, { aliases: event.target.value })}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <Switch
                        checked={draft.hotword}
                        disabled={!canEdit}
                        aria-label={t.glossaryHotword}
                        onCheckedChange={(checked) => update(draft.key, { hotword: Boolean(checked) })}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      {canEdit ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={formatMessage(t.glossaryRemoveTerm, { term: draft.term || "—" })}
                          onClick={() => {
                            setDrafts((current) => current.filter((item) => item.key !== draft.key))
                            setServerErrors(new Map())
                          }}
                        >
                          <Trash2Icon aria-hidden="true" />
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )
              })}
              {builtIn.map((term) => (
                <TableRow key={`builtin-${term.term}`} className="text-fg-3">
                  <TableCell>
                    <bdi>{term.term}</bdi>
                    <span className="ms-2 rounded-sm bg-surface-3 px-1.5 py-0.5 text-2xs text-fg-2">
                      {t.glossaryBuiltIn}
                    </span>
                  </TableCell>
                  <TableCell>
                    <bdi dir="auto">{term.aliases.join(", ")}</bdi>
                  </TableCell>
                  <TableCell>
                    <Switch checked={term.hotword} disabled aria-label={`${t.glossaryHotword}: ${term.term}`} />
                  </TableCell>
                  <TableCell />
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {canEdit ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={atLimit}
                onClick={() =>
                  setDrafts((current) => [...current, { key: draftKey(), term: "", aliases: "", hotword: true }])
                }
              >
                <PlusIcon data-icon="inline-start" aria-hidden="true" />
                {t.glossaryAddTerm}
              </Button>
              <Button size="sm" disabled={saving || errors.size > 0} onClick={() => void save()}>
                {t.glossarySave}
              </Button>
            </div>
          ) : null}
        </>
      )}

      {canSeeStatus ? <AsrStatusSummary dictionary={t} /> : null}
    </section>
  )
}

function AsrStatusSummary({ dictionary: t }: { dictionary: Dictionary }) {
  const { fmt } = useI18n()
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const response = await fetch("/api/asr/status")

        if (!response.ok) throw new Error(String(response.status))

        const body = (await response.json()) as StatusPayload

        if (!cancelled) setStatus(body)
      } catch {
        if (!cancelled) setFailed(true)
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [])

  if (failed) return <p className="text-sm text-fg-3">{t.asrStatusLoadFailed}</p>
  if (!status) return null

  const health = (provider: string) => status.providers.find((item) => item.provider === provider)
  const state = (provider: string) => {
    const item = health(provider)

    if (!item?.configured) return t.asrStatusNotConfigured
    if (item.breakerOpenUntil) {
      return formatMessage(t.asrStatusBreakerOpen, {
        time: fmt.date(item.breakerOpenUntil, "time"),
      })
    }
    if (item.healthy === true) return t.asrStatusHealthy
    if (item.healthy === false) return t.asrStatusUnhealthy

    return t.asrStatusUnknown
  }
  const chains = [
    { label: t.asrStatusChain, providers: status.chain },
    { label: t.asrStatusNonHebrewChain, providers: status.nonHebrewChain },
  ]

  return (
    <div className="grid gap-2 border-t border-line pt-3">
      <h4 className="text-sm font-semibold text-fg">{t.asrStatusTitle}</h4>
      {!status.chain.length && !status.nonHebrewChain.length ? (
        <p className="text-sm text-fg-3">{t.asrStatusEmpty}</p>
      ) : (
        <dl className="grid gap-1.5 text-sm">
          {chains.map((chain) => (
            <div key={chain.label} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <dt className="text-fg-3">{chain.label}</dt>
              <dd className="flex flex-wrap gap-1.5">
                {chain.providers.map((provider, index) => (
                  <span key={provider} className="inline-flex items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 text-xs">
                    <span className="font-mono tabular-nums [direction:ltr] [unicode-bidi:isolate]">{index + 1}.</span>
                    <bdi className="font-medium text-fg">{provider}</bdi>
                    <span className="text-fg-3">{state(provider)}</span>
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
