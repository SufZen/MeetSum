import type { MeetingRecord, SuggestedAgentRun } from "@/lib/meetings/repository"

type SuggestionTarget = SuggestedAgentRun["target"]

export type MeetingAgentSuggestionInput = {
  target: SuggestionTarget
  payload: Record<string, unknown>
}

/**
 * Suggested agent runs carry an `intent` code; the UI translates it
 * (`AGENT_INTENT_KEYS` in components/meeting-right-rail.tsx). M9: no English
 * title or description is stored in the payload.
 */
const suggestionCatalog: Array<{ intent: string; target: SuggestionTarget }> = [
  { intent: "export_to_realizeos", target: "realizeos" },
  { intent: "draft_followup_email", target: "mcp" },
  { intent: "create_n8n_payload", target: "n8n" },
  { intent: "draft_client_recap", target: "mcp" },
  { intent: "extract_crm_notes", target: "webhook" },
]

function hasProcessedMeetingContent(meeting: MeetingRecord) {
  return Boolean(
    meeting.summary?.overview?.trim() ||
      meeting.summary?.decisions?.length ||
      meeting.summary?.actionItems?.length ||
      meeting.transcript?.length
  )
}

function existingActiveSuggestionKeys(meeting: MeetingRecord) {
  return new Set(
    (meeting.suggestedAgentRuns ?? [])
      .filter((run) => run.status !== "failed")
      .map((run) => `${run.target}:${String(run.payload.intent ?? "")}`)
  )
}

function participantNames(meeting: MeetingRecord) {
  const names = meeting.participantDetails?.length
    ? meeting.participantDetails.map((participant) => participant.name)
    : meeting.participants

  return Array.from(new Set(names.filter(Boolean)))
}

function openActionItems(meeting: MeetingRecord) {
  return (meeting.summary?.actionItems ?? []).filter((item) => item.status !== "done")
}

export function buildMeetingAgentSuggestions(
  meeting: MeetingRecord
): MeetingAgentSuggestionInput[] {
  if (!hasProcessedMeetingContent(meeting)) return []

  const activeKeys = existingActiveSuggestionKeys(meeting)
  const actions = openActionItems(meeting)

  return suggestionCatalog
    .filter((suggestion) => !activeKeys.has(`${suggestion.target}:${suggestion.intent}`))
    .map((suggestion) => ({
      target: suggestion.target,
      payload: {
        intent: suggestion.intent,
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        meetingStatus: meeting.status,
        source: meeting.source,
        language: meeting.language,
        languageMetadata: meeting.languageMetadata,
        participantNames: participantNames(meeting),
        tags: meeting.tags ?? [],
        actionItemCount: actions.length,
        decisionCount: meeting.summary?.decisions?.length ?? 0,
        transcriptSegmentCount: meeting.transcript?.length ?? 0,
        overview: meeting.summary?.overview,
        requiresApproval: true,
        generatedBy: "meetsum-agent-suggestions-v1",
      },
    }))
}
