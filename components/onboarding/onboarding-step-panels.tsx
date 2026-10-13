"use client"

/**
 * The action of each onboarding step (docs/parity/m9.md C3), built on the
 * existing APIs: Google connect (`/api/auth/google/start`), invitations
 * (`POST /api/workspaces/current/invitations`), the ASR glossary
 * (`GET/PUT /api/asr/glossary`) and the M1 upload (`POST /api/meetings`, then
 * `POST /api/meetings/[id]/upload`). Each calls `onChanged` so the live step
 * status is re-read.
 */
import { UploadIcon } from "lucide-react"
import { useId, useRef, useState, type FormEvent } from "react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"

type GlossaryTermInput = { term: string; aliases: string[]; hotword: boolean; caseSensitive?: boolean }
type GlossaryResponse = { glossary: { terms: GlossaryTermInput[] }; defaults: { terms: GlossaryTermInput[] } }

const same = (a: GlossaryTermInput, b: GlossaryTermInput) => JSON.stringify(a) === JSON.stringify(b)

/** Workspace terms = effective terms that are not unchanged built-in defaults. */
export function workspaceTerms(body: GlossaryResponse): GlossaryTermInput[] {
  return body.glossary.terms.filter((term) => !body.defaults.terms.some((builtIn) => same(builtIn, term)))
}

export function GoogleStepPanel({ locale, done }: { locale: string; done: boolean }) {
  const { t } = useI18n()

  if (done) return <p className="text-sm text-ok-text">{t("onboardingGoogleConnected")}</p>

  return (
    <a
      href={`/api/auth/google/start?returnTo=${encodeURIComponent(`/${locale}/onboarding`)}`}
      className={buttonVariants({ className: "justify-self-start" })}
    >
      {t("onboardingGoogleConnect")}
    </a>
  )
}

export function InviteStepPanel({ locale, onChanged }: { locale: string; onChanged: () => void }) {
  const { t } = useI18n()
  const emailId = useId()
  const roleId = useId()
  const [email, setEmail] = useState("")
  const [role, setRole] = useState("member")
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      const response = await fetch("/api/workspaces/current/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role, locale }),
      })

      if (!response.ok) throw new Error(String(response.status))
      toast.success(t("onboardingInviteSent", { email }))
      setEmail("")
      onChanged()
    } catch {
      toast.error(t("onboardingInviteFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
      <div className="grid gap-1">
        <label htmlFor={emailId} className="text-sm font-medium text-fg">
          {t("onboardingInviteEmail")}
        </label>
        <Input id={emailId} type="email" dir="ltr" required value={email} onChange={(event) => setEmail(event.target.value)} />
      </div>
      <div className="grid gap-1">
        <label htmlFor={roleId} className="text-sm font-medium text-fg">
          {t("onboardingInviteRole")}
        </label>
        <NativeSelect id={roleId} value={role} onChange={(event) => setRole(event.target.value)}>
          <NativeSelectOption value="member">{t("roleMember")}</NativeSelectOption>
          <NativeSelectOption value="admin">{t("roleAdmin")}</NativeSelectOption>
          <NativeSelectOption value="viewer">{t("roleViewer")}</NativeSelectOption>
        </NativeSelect>
      </div>
      <Button type="submit" disabled={busy || !email}>
        {t("onboardingInviteSend")}
      </Button>
    </form>
  )
}

export function GlossaryStepPanel({ suggestions, onChanged }: { suggestions: string[]; onChanged: () => void }) {
  const { t } = useI18n()
  const termId = useId()
  const [term, setTerm] = useState("")
  const [busy, setBusy] = useState(false)

  const add = async (value: string) => {
    const clean = value.trim()

    if (!clean) return
    setBusy(true)
    try {
      const current = await fetch("/api/asr/glossary", { cache: "no-store" })

      if (!current.ok) throw new Error(String(current.status))

      const terms = workspaceTerms((await current.json()) as GlossaryResponse).filter(
        (item) => item.term.toLocaleLowerCase() !== clean.toLocaleLowerCase()
      )
      const response = await fetch("/api/asr/glossary", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, terms: [...terms, { term: clean, aliases: [], hotword: true }] }),
      })

      if (!response.ok) throw new Error(String(response.status))
      toast.success(t("onboardingGlossaryAdded", { term: clean }))
      setTerm("")
      onChanged()
    } catch {
      toast.error(t("onboardingGlossaryFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-3">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void add(term)
        }}
        className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
      >
        <div className="grid gap-1">
          <label htmlFor={termId} className="text-sm font-medium text-fg">
            {t("onboardingGlossaryTerm")}
          </label>
          <Input id={termId} dir="auto" maxLength={64} value={term} onChange={(event) => setTerm(event.target.value)} />
        </div>
        <Button type="submit" disabled={busy || !term.trim()}>
          {t("onboardingGlossaryAdd")}
        </Button>
      </form>
      {suggestions.length ? (
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-fg-3">{t("onboardingGlossarySuggestions")}</span>
          <ul className="flex flex-wrap gap-1.5">
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void add(suggestion)}>
                  <bdi>{suggestion}</bdi>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

export function UploadStepPanel({ done, onChanged }: { done: boolean; onChanged: () => void }) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const [status, setStatus] = useState<"idle" | "uploading" | "done">(done ? "done" : "idle")
  const [dragging, setDragging] = useState(false)

  const upload = async (file: File) => {
    setStatus("uploading")
    try {
      const created = await fetch("/api/meetings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: file.name.replace(/\.[^.]+$/, "") || t("onboardingUploadDefaultTitle"),
          source: "upload",
          language: "mixed",
          startedAt: new Date().toISOString(),
          participants: [],
        }),
      })
      const body = (await created.json()) as { meeting?: { id: string } }

      if (!created.ok || !body.meeting) throw new Error(String(created.status))

      const form = new FormData()

      form.set("file", file)

      const uploaded = await fetch(`/api/meetings/${encodeURIComponent(body.meeting.id)}/upload`, { method: "POST", body: form })

      if (!uploaded.ok) throw new Error(String(uploaded.status))
      setStatus("done")
      toast.success(t("onboardingUploaded"))
      onChanged()
    } catch {
      setStatus("idle")
      toast.error(t("onboardingUploadFailed"))
    }
  }

  if (status === "done") return <p className="text-sm text-ok-text">{t("onboardingUploaded")}</p>

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        const file = event.dataTransfer.files[0]
        if (file) void upload(file)
      }}
      className={`grid justify-items-center gap-2 rounded-lg border border-dashed p-6 text-center ${dragging ? "border-brand bg-brand-soft" : "border-line-strong bg-surface"}`}
    >
      <UploadIcon aria-hidden className="size-6 text-fg-3" />
      <p className="text-sm text-fg-2">{t("onboardingUploadDrop")}</p>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="audio/*,video/*"
        className="sr-only"
        aria-label={t("onboardingUploadChoose")}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void upload(file)
        }}
      />
      <Button variant="outline" disabled={status === "uploading"} onClick={() => inputRef.current?.click()}>
        {status === "uploading" ? t("onboardingUploading") : t("onboardingUploadChoose")}
      </Button>
    </div>
  )
}
