import type { MeetingRecord } from "@/lib/meetings/repository"

export const DEMO_MEETINGS: MeetingRecord[] = [
  {
    id: "meet_google_workspace",
    title: "Google Workspace rollout",
    source: "google_meet",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-04-23T09:00:00.000Z",
    participants: ["Ran", "Maya", "Codex"],
    summary: {
      overview:
        "Workspace is the primary context source. Calendar finds the meeting, Drive imports the Meet recording, Gmail adds prep and follow-up context.",
      decisions: [
        "Use domain-wide delegation with narrow scopes.",
        "Import Google Meet recordings from Drive before building a bot.",
      ],
      actionItems: [
        {
          id: "act_google_1",
          title: "Create the Workspace admin service account",
          owner: "Ran",
          status: "open",
        },
        {
          id: "act_google_2",
          title: "Map all calendars and shared drives",
          owner: "Codex",
          status: "open",
        },
      ],
    },
    transcript: [
      {
        id: "seg_google_1",
        speaker: "Ran",
        startMs: 0,
        endMs: 5000,
        text: "Google Calendar should be the source of truth for every meeting.",
      },
      {
        id: "seg_google_2",
        speaker: "Maya",
        startMs: 5400,
        endMs: 11200,
        text: "Drive recordings should be imported automatically after Meet finishes processing.",
      },
    ],
  },
  {
    id: "meet_realizeos",
    title: "RealizeOS context bridge",
    source: "upload",
    language: "he",
    status: "indexing",
    retention: "audio",
    startedAt: "2026-04-22T14:30:00.000Z",
    participants: ["Ran", "Ops agent"],
    summary: {
      overview:
        "RealizeOS should receive compact meeting memory packets with decisions, action items, owners, and source links.",
      decisions: ["Start with outbound REST webhooks, then add MCP tools."],
      actionItems: [
        {
          id: "act_realizeos_1",
          title: "Define the RealizeOS meeting-context payload",
          owner: "Ran",
          status: "open",
        },
      ],
    },
    transcript: [
      {
        id: "seg_realizeos_1",
        speaker: "Ran",
        startMs: 0,
        endMs: 4200,
        text: "We need RealizeOS to receive context from every meeting.",
      },
    ],
  },
  {
    id: "meet_hebrew_quality",
    title: "Hebrew summary quality review",
    source: "pwa_recorder",
    language: "he",
    status: "summarizing",
    retention: "audio",
    startedAt: "2026-04-21T11:00:00.000Z",
    participants: ["Ran", "Noa"],
    summary: {
      overview:
        "Hebrew output should preserve names, jargon, dates, responsibility, and uncertainty markers.",
      decisions: ["Escalate low-confidence Hebrew chunks to a stronger API model."],
      actionItems: [
        {
          id: "act_hebrew_1",
          title: "Build a Hebrew regression sample set",
          owner: "Noa",
          status: "open",
        },
      ],
    },
    transcript: [
      {
        id: "seg_hebrew_1",
        speaker: "Noa",
        startMs: 0,
        endMs: 6100,
        text: "Accuracy in Hebrew matters more than saving a few cents on difficult chunks.",
      },
    ],
  },
]
