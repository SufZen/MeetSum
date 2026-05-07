import type { MeetingRecord, SuggestedAgentRun } from "@/lib/meetings/repository"

type SuggestionTarget = SuggestedAgentRun["target"]

export type MeetingAgentSuggestionInput = {
  target: SuggestionTarget
  payload: Record<string, unknown>
}

const suggestionCatalog: Array<{
  intent: string
  target: SuggestionTarget
  title: string
  description: string
}> = [
  {
    intent: "export_to_realizeos",
    target: "realizeos",
    title: "Export to RealizeOS",
    description: "Send structured meeting context into RealizeOS memory.",
  },
  {
    intent: "draft_followup_email",
    target: "mcp",
    title: "Draft follow-up email",
    description: "Prepare a follow-up draft from decisions and open action items.",
  },
  {
    intent: "create_n8n_payload",
    target: "n8n",
    title: "Create n8n payload",
    description: "Prepare a signed automation payload for downstream workflows.",
  },
  {
    intent: "draft_client_recap",
    target: "mcp",
    title: "Draft client recap",
    description: "Turn the summary into a concise client-ready recap.",
  },
  {
    intent: "extract_crm_notes",
    target: "webhook",
    title: "Extract CRM notes",
    description: "Create CRM-ready notes with participants, topics, and next steps.",
  },
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
        title: suggestion.title,
        description: suggestion.description,
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
