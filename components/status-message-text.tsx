"use client"

/**
 * Renders provider / workspace status codes (lib/ops/status-messages.ts) in
 * the active locale. Environment variable names stay literal: they render
 * as LTR `<code>` inside the translated sentence.
 */
import { Fragment } from "react"

import { useI18n } from "@/components/i18n-provider"
import { PROVIDER_LABEL_KEYS, STATUS_MESSAGE_KEYS, type StatusMessage } from "@/lib/ops/status-messages"

/** An environment variable name (`GOOGLE_GEMINI_API_KEY`): caps with an underscore. */
const ENV_NAME = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g

type Translate = (key: string, values?: Record<string, string | number | undefined>) => string

export function statusMessageString(t: Translate, message: StatusMessage | undefined, fallback = ""): string {
  if (!message) return fallback

  const key = STATUS_MESSAGE_KEYS[message.code]

  return key ? t(key, message.params) : fallback
}

export function providerLabelString(t: Translate, provider: { labelId?: string; label: string }): string {
  const key = provider.labelId ? PROVIDER_LABEL_KEYS[provider.labelId] : undefined

  return key ? t(key) : provider.label
}

/** Splits text so env names render as `<code dir="ltr">`. */
export function withEnvCode(text: string) {
  const parts: Array<string | { env: string }> = []
  let last = 0

  for (const match of text.matchAll(ENV_NAME)) {
    const index = match.index ?? 0

    if (index > last) parts.push(text.slice(last, index))
    parts.push({ env: match[0] })
    last = index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))

  return parts.map((part, index) =>
    typeof part === "string" ? (
      <Fragment key={index}>{part}</Fragment>
    ) : (
      <code key={index} dir="ltr" className="font-mono text-[0.92em]">
        {part.env}
      </code>
    )
  )
}

export function StatusMessageText({ message, fallback }: { message?: StatusMessage; fallback?: string }) {
  const { t } = useI18n()

  return <>{withEnvCode(statusMessageString(t, message, fallback))}</>
}
