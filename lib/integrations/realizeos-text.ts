/**
 * English text for the outbound RealizeOS payload (schemaVersion 2). The
 * meeting API returns codes the UI translates; RealizeOS consumers of the v1
 * payload read English `title`/`message` (quality warnings) and
 * `title`/`description` (suggested runs), so the export dual-emits them,
 * derived from the code with the en dictionary at export time.
 */
import { AGENT_INTENT_KEYS } from "@/lib/agents/intent-messages"
import { m9ContentMeetingMessages } from "@/lib/i18n/m9/content-meeting"
import { fillMessage, pluralMessage } from "@/lib/i18n/messages"
import type { MeetingQualityWarning } from "@/lib/meetings/repository"

const en: Readonly<Record<string, string>> = m9ContentMeetingMessages.en

const QUALITY_WARNING_KEYS: Record<MeetingQualityWarning["code"], { title: string; message: string }> = {
  smart_notes_only: { title: "mtgQualitySmartNotesOnlyTitle", message: "mtgQualitySmartNotesOnlyDetail" },
  transcription_fallback: { title: "mtgQualityFallbackTitle", message: "mtgQualityFallbackDetail" },
  weak_transcript_confidence: { title: "mtgQualityWeakConfidenceTitle", message: "mtgQualityWeakConfidenceDetail" },
  no_speaker_diarization: { title: "mtgQualityGenericSpeakersTitle", message: "mtgQualityGenericSpeakersDetail" },
  summary_language_mismatch: { title: "mtgQualityLanguageMismatchTitle", message: "mtgQualityLanguageMismatchDetail" },
  task_missing_owner_or_due_date: { title: "mtgQualityTasksIncompleteTitle", message: "mtgQualityTasksIncompleteDetail" },
}

export function englishQualityWarningText(warning: MeetingQualityWarning): { title: string; message: string } {
  const keys = QUALITY_WARNING_KEYS[warning.code]

  if (!keys) return { title: String(warning.code), message: "" }

  const values = warning.params ?? {}
  const message =
    warning.code === "task_missing_owner_or_due_date"
      ? pluralMessage(en, "en", keys.message, typeof values.count === "number" ? values.count : 0, values)
      : fillMessage(en[keys.message] ?? "", { provider: "—", ...values })

  return { title: en[keys.title] ?? String(warning.code), message }
}

export function englishSuggestionText(intent: string): { title: string; description: string } {
  const keys = AGENT_INTENT_KEYS[intent]

  return keys
    ? { title: en[keys.title] ?? intent, description: en[keys.description] ?? "" }
    : { title: intent, description: "" }
}
