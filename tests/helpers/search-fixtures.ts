/**
 * Small two-workspace corpus for B's search tests: W1 has a shared budget
 * meeting, a hiring meeting and a private meeting; W2 has a meeting with the
 * same colliding term. Use with the search doubles (search-doubles.ts).
 */
import type { MeetingRecord } from "@/lib/meetings/repository"

import { testMeeting } from "./route-ctx"

export const COLLIDING_TERM = "פלמינגו"

export function searchCorpus(): MeetingRecord[] {
  return [
    testMeeting({
      id: "m_budget",
      workspaceId: "ws_a",
      title: "ישיבת תקציב רבעונית",
      startedAt: "2026-09-01T09:00:00.000Z",
      source: "upload",
      language: "he",
      tags: ["finance"],
      participants: ["דנה כהן", "רון לוי"],
      participantDetails: [
        { id: "p1", meetingId: "m_budget", name: "דנה כהן", email: "dana@a.com", role: "organizer", source: "manual", attendanceStatus: "accepted", createdAt: "", updatedAt: "" },
      ],
      contexts: [{ id: "room_fin", name: "כספים", createdAt: "2026-01-01T00:00:00.000Z" }],
      speakers: [
        { id: "spk_dana", meetingId: "m_budget", label: "A", displayName: "דנה", mappingStatus: "confirmed", source: "asr", talkTimeMs: 0, wordCount: 0, segmentCount: 0 },
        { id: "spk_ron", meetingId: "m_budget", label: "B", displayName: "רון", mappingStatus: "confirmed", source: "asr", talkTimeMs: 0, wordCount: 0, segmentCount: 0 },
      ],
      transcript: [
        { id: "b1", speaker: "A", speakerId: "spk_dana", turnIndex: 0, startMs: 0, endMs: 4000, text: "בואו נתחיל מהתקציב של הרבעון" },
        { id: "b2", speaker: "A", speakerId: "spk_dana", turnIndex: 0, startMs: 4000, endMs: 8000, text: "והתקציב השנתי עלה ב-1,200 שקל" },
        { id: "b3", speaker: "B", speakerId: "spk_ron", turnIndex: 1, startMs: 8000, endMs: 12000, text: "צריך לעבור ל-Supabase עד Q3" },
        { id: "b4", speaker: "A", speakerId: "spk_dana", turnIndex: 2, startMs: 12000, endMs: 16000, text: `גם ה${COLLIDING_TERM} עלה על השולחן` },
      ],
      summary: {
        overview: "הוחלט לאשר את התקציב השנתי",
        decisions: ["לאשר את התקציב"],
        actionItems: [{ id: "ai_1", title: "רון יכין דו״ח תקציב", status: "open", owner: "רון", sourceStartMs: 8000 }],
      },
      intelligence: { meetingType: "board" } as MeetingRecord["intelligence"],
    }),
    testMeeting({
      id: "m_hiring",
      workspaceId: "ws_a",
      title: "גיוס מפתחים",
      startedAt: "2026-08-01T09:00:00.000Z",
      source: "google_meet",
      language: "he",
      tags: ["hr"],
      participants: ["יעל"],
      contexts: [{ id: "room_hr", name: "משאבי אנוש", createdAt: "2026-01-01T00:00:00.000Z" }],
      transcript: [
        { id: "h1", speaker: "יעל", startMs: 0, endMs: 5000, text: "נגייס שני מפתחים חדשים לצוות" },
        { id: "h2", speaker: "יעל", startMs: 5000, endMs: 9000, text: "התקציב לגיוס כבר מאושר" },
      ],
    }),
    testMeeting({
      id: "m_private",
      workspaceId: "ws_a",
      visibility: "private",
      ownerUserId: "user_owner",
      title: "שיחה פרטית על תקציב",
      startedAt: "2026-09-05T09:00:00.000Z",
      transcript: [{ id: "p1", speaker: "X", startMs: 0, endMs: 5000, text: `סוד: התקציב הנסתר ו${COLLIDING_TERM}` }],
    }),
    testMeeting({
      id: "m_w2",
      workspaceId: "ws_b",
      title: "Workspace B",
      startedAt: "2026-09-02T09:00:00.000Z",
      transcript: [{ id: "w1", speaker: "Z", startMs: 0, endMs: 5000, text: `התקציב של B ו${COLLIDING_TERM}` }],
    }),
  ]
}
