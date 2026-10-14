/**
 * M8 browser e2e seed (docs/parity/m8.md, D5; Acceptance 14).
 *
 *   npm run integrations:e2e-seed                       # seed
 *   npm run integrations:e2e-seed -- --complete <id>    # fire the completion events
 *
 * Needs DATABASE_URL (migrated, 027 applied) and MEETSUM_SESSION_SECRET (the
 * app's). Seeds two workspaces (W1, W2) and four users (W1 owner, W1 member,
 * W2 owner, plus the bot-less fixture people), a Hebrew W1 meeting with a
 * summary, decisions and action items, a private W1 meeting owned by the W1
 * member, a W2 meeting, and a Google calendar row whose iCalUID the fake
 * Outlook calendar repeats (step 6 dedupe). Signed test session cookies and
 * the seeded ids go to E2E_ENV_FILE (default `.secrets/e2e-m8.env`,
 * gitignored), never to stdout. Re-running replaces the seeded rows (ids
 * prefixed `e2e_m8_`).
 *
 * `--complete <meetingId>` runs the real post-processing dispatch path
 * without ASR: for the meeting's summary, each action item and the meeting,
 * it delivers the platform event to webhooks (visibility-minimized) and calls
 * `enqueueIntegrationEvent`, exactly as `deliverPlatformEvent` in
 * lib/jobs/processor.ts does. Each run uses fresh event ids, so idempotency
 * comes from the per-rule delivery keys, which is what step 3 checks.
 */
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { createSessionCookie, getSessionSecret } from "@/lib/auth/session"
import { getDatabasePool } from "@/lib/db/client"
import { enqueueIntegrationEvent } from "@/lib/integrations/core/dispatch-hook"
import { fakeSharedEvent } from "@/lib/integrations/microsoft/fake"
import { platformEventData } from "@/lib/jobs/processor"
import type { MeetingRecord, MeetingVisibility } from "@/lib/meetings/repository"
import { platformEventPayload } from "@/lib/platform/event-payloads"
import type { PlatformEventName } from "@/lib/platform/events"
import { seedPgliteMeetings } from "@/lib/search/eval/pglite"
import { deliverWebhookEvent } from "@/lib/webhooks/delivery"
import { suiteEnvFile } from "@/scripts/e2e/env-file"

const PREFIX = "e2e_m8_"
const W1 = `${PREFIX}ws_1`
const W2 = `${PREFIX}ws_2`
const USERS = {
  w1Owner: { id: `${PREFIX}user_w1_owner`, email: "m8-w1-owner@example.test", workspace: W1, role: "owner" },
  w1Member: { id: `${PREFIX}user_w1_member`, email: "m8-w1-member@example.test", workspace: W1, role: "member" },
  w2Owner: { id: `${PREFIX}user_w2_owner`, email: "m8-w2-owner@example.test", workspace: W2, role: "owner" },
} as const
const MEETINGS = {
  hebrew: `${PREFIX}meeting_he`,
  private: `${PREFIX}meeting_private`,
  w2: `${PREFIX}meeting_w2`,
  calendar: `${PREFIX}meeting_calendar`,
  recap: `${PREFIX}meeting_recap`,
} as const
/** The fake Outlook calendar returns an event with this iCalUID (Acceptance 14, step 6). */
export const E2E_M8_ICAL_UID = "e2e-m8-shared-event@meetsum.test"

type SeedMeeting = MeetingRecord & {
  overview: string
  decisions: string[]
  actions: { id: string; title: string; owner?: string; dueDate?: string; priority?: string }[]
  calendarEventId?: string
}

function meeting(
  id: string,
  workspaceId: string,
  ownerUserId: string,
  visibility: MeetingVisibility,
  overrides: Partial<SeedMeeting>
): SeedMeeting {
  const startedAt = "2026-10-12T09:00:00.000Z"

  return {
    id,
    title: "",
    source: "upload",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt,
    participants: [],
    participantDetails: [],
    workspaceId,
    ownerUserId,
    visibility,
    durationMs: 32 * 60_000,
    transcriptVersion: 1,
    transcript: [],
    overview: "",
    decisions: [],
    actions: [],
    ...overrides,
  }
}

function participant(meetingId: string, index: number, name: string, email: string) {
  return {
    id: `${meetingId}_p${index}`,
    meetingId,
    name,
    email,
    role: "attendee" as const,
    source: "calendar" as const,
    attendanceStatus: "accepted" as const,
    createdAt: "2026-10-12T09:00:00.000Z",
    updatedAt: "2026-10-12T09:00:00.000Z",
  }
}

function seededMeetings(): SeedMeeting[] {
  const hebrew = meeting(MEETINGS.hebrew, W1, USERS.w1Owner.id, "workspace", {
    title: "עדכון סטטוס עסקה — Lisboa Riverside",
    participants: ["דנה כהן", "Rui Santos"],
    participantDetails: [
      participant(MEETINGS.hebrew, 0, "דנה כהן", USERS.w1Owner.email),
      participant(MEETINGS.hebrew, 1, "Rui Santos", "rui@partner.example"),
    ],
    transcript: [
      { id: `${MEETINGS.hebrew}_s1`, startMs: 0, endMs: 6_000, text: "בוקר טוב, נתחיל בעדכון על Lisboa Riverside.", speakerId: undefined },
      { id: `${MEETINGS.hebrew}_s2`, startMs: 6_000, endMs: 14_000, text: "הבנק אישר את המימון בתנאים שסיכמנו.", speakerId: undefined },
    ] as MeetingRecord["transcript"],
    overview:
      "הפגישה עסקה בעדכון הסטטוס של עסקת Lisboa Riverside. הבנק אישר את המימון, ונקבע שהבדיקה המשפטית תסתיים עד סוף החודש. " +
      "הוחלט לקדם את החתימה ולתאם סיור באתר עם המשקיעים.",
    decisions: ["לקדם את החתימה לשבוע הבא", "לתאם סיור באתר עם המשקיעים"],
    actions: [
      { id: `${MEETINGS.hebrew}_a1`, title: "לשלוח את טיוטת ההסכם לעורך הדין", owner: "דנה כהן", dueDate: "2026-10-20", priority: "high" },
      { id: `${MEETINGS.hebrew}_a2`, title: "לתאם סיור באתר", owner: "Rui Santos", priority: "normal" },
    ],
  })
  const privateMeeting = meeting(MEETINGS.private, W1, USERS.w1Member.id, "private", {
    title: "שיחה פרטית על תקציב",
    participants: ["חבר צוות"],
    participantDetails: [participant(MEETINGS.private, 0, "חבר צוות", USERS.w1Member.email)],
    overview: "שיחה פרטית על התקציב לרבעון הבא.",
    decisions: ["לבדוק שוב את התחזית"],
    actions: [{ id: `${MEETINGS.private}_a1`, title: "לעדכן את התחזית", priority: "normal" }],
  })
  const w2 = meeting(MEETINGS.w2, W2, USERS.w2Owner.id, "workspace", {
    title: "Workspace 2 meeting",
    language: "en",
    overview: "Only visible in workspace 2.",
    actions: [{ id: `${MEETINGS.w2}_a1`, title: "W2 follow-up" }],
  })
  const calendar = meeting(MEETINGS.calendar, W1, USERS.w1Member.id, "workspace", {
    title: "פגישה מתוזמנת מהיומן",
    status: "scheduled",
    source: "google_meet",
    calendarEventId: `${PREFIX}cal_google_1`,
  })

  // A second recap meeting: test 7 completes it after unsubscribing, so the
  // check runs on a new rule key (re-completing the first one is a no-op anyway).
  const recap = meeting(MEETINGS.recap, W1, USERS.w1Owner.id, "workspace", {
    title: "סיכום שבועי של הצוות",
    participants: ["דנה כהן"],
    participantDetails: [participant(MEETINGS.recap, 0, "דנה כהן", USERS.w1Owner.email)],
    overview: "סקירה שבועית של המשימות הפתוחות בצוות.",
    decisions: ["להמשיך במעקב שבועי"],
    actions: [],
  })

  return [hebrew, privateMeeting, w2, calendar, recap]
}

async function seed() {
  const secret = getSessionSecret()
  const pool = getDatabasePool()
  const meetings = seededMeetings()

  // Integration rows reference meetings and workspaces; clear them first.
  for (const table of ["integration_deliveries", "integration_links", "integration_rules", "meeting_integration_prefs", "email_recap_unsubscribes"]) {
    await pool.query(`delete from ${table} where workspace_id like 'e2e\\_m8\\_%'`)
  }
  // An Outlook sync creates meetings and calendar_events whose ids lack the e2e
  // prefix. Deleting the connection cascades to those calendar_events, which the
  // meetings still reference (meetings_calendar_event_id_fkey), so clear by
  // workspace: meetings first, then calendar_events, then the connections.
  await pool.query("delete from meetings where workspace_id like 'e2e\\_m8\\_%' or id like 'e2e\\_m8\\_%'")
  await pool.query("delete from calendar_events where workspace_id like 'e2e\\_m8\\_%' or id like 'e2e\\_m8\\_%'")
  await pool.query("delete from integration_connections where workspace_id like 'e2e\\_m8\\_%'")

  for (const user of Object.values(USERS)) {
    await pool.query("insert into users (id, email) values ($1, $2) on conflict do nothing", [user.id, user.email])
  }
  for (const workspace of [W1, W2]) {
    await pool.query("insert into workspaces (id, name, slug) values ($1, $1, $1) on conflict do nothing", [workspace])
  }
  for (const user of Object.values(USERS)) {
    await pool.query(
      "insert into memberships (workspace_id, user_id, role) values ($1, $2, $3) on conflict (workspace_id, user_id) do update set role = excluded.role",
      [user.workspace, user.id, user.role]
    )
    await pool.query("update users set default_workspace_id = $2 where id = $1", [user.id, user.workspace])
  }

  // A Google calendar row the fake Outlook event duplicates: same iCalUID,
  // same start and same Teams link as `fakeSharedEvent()` (the dedupe needs all three).
  const shared = fakeSharedEvent()

  await pool.query(
    "insert into workspace_accounts (id, domain, admin_email) values ($1, 'example.test', $2) on conflict do nothing",
    [`${PREFIX}wsacct`, USERS.w1Owner.email]
  )
  await pool.query(
    "insert into google_identities (id, workspace_account_id, subject_email, workspace_id) values ($1, $2, $3, $4) on conflict do nothing",
    [`${PREFIX}gid_member`, `${PREFIX}wsacct`, USERS.w1Member.email, W1]
  )
  await pool.query(
    `insert into calendar_events (id, google_identity_id, google_event_id, title, starts_at, ends_at, meet_link, raw, provider, workspace_id, ical_uid)
     values ($1, $2, 'e2e-google-event-1', 'פגישה מתוזמנת מהיומן', $6::timestamptz, $7::timestamptz,
             $8, $3::jsonb, 'google', $4, $5)
     on conflict (id) do nothing`,
    [
      `${PREFIX}cal_google_1`,
      `${PREFIX}gid_member`,
      JSON.stringify(shared.googleRaw),
      W1,
      E2E_M8_ICAL_UID,
      shared.start.toISOString(),
      shared.end.toISOString(),
      shared.joinUrl,
    ]
  )

  await seedPgliteMeetings({ client: pool }, meetings)

  for (const item of meetings) {
    if (item.calendarEventId) {
      await pool.query("update meetings set calendar_event_id = $2 where id = $1", [item.id, item.calendarEventId])
    }
    if (!item.overview) continue
    const summaryId = `${item.id}_summary`

    await pool.query(
      "insert into summaries (id, meeting_id, overview, language) values ($1, $2, $3, $4) on conflict (id) do nothing",
      [summaryId, item.id, item.overview, item.language]
    )
    await pool.query(
      "insert into summary_sections (id, summary_id, kind, content) values ($1, $2, 'decisions', $3::jsonb) on conflict (id) do nothing",
      [`${summaryId}_decisions`, summaryId, JSON.stringify(item.decisions)]
    )
    for (const action of item.actions) {
      await pool.query(
        // due_on (date-only) is what the recap shows; due_date stays for M2 views.
        `insert into action_items (id, meeting_id, title, owner, status, due_date, due_on, priority, workspace_id)
         values ($1, $2, $3, $4, 'open', $5::text::timestamptz, $5::text::date, $6, $7) on conflict (id) do nothing`,
        [action.id, item.id, action.title, action.owner ?? null, action.dueDate ?? null, action.priority ?? "normal", item.workspaceId]
      )
    }
  }

  const file = suiteEnvFile("m8")
  const cookie = (user: (typeof USERS)[keyof typeof USERS]) => createSessionCookie({ userId: user.id, email: user.email }, { secret }).value
  const lines = [
    "# Generated by npm run integrations:e2e-seed. Test-only session cookies; do not commit.",
    `E2E_M8_W1_OWNER_SESSION=${cookie(USERS.w1Owner)}`,
    `E2E_M8_W1_MEMBER_SESSION=${cookie(USERS.w1Member)}`,
    `E2E_M8_W2_OWNER_SESSION=${cookie(USERS.w2Owner)}`,
    `E2E_M8_W1_WORKSPACE_ID=${W1}`,
    `E2E_M8_W2_WORKSPACE_ID=${W2}`,
    `E2E_M8_HEBREW_MEETING_ID=${MEETINGS.hebrew}`,
    `E2E_M8_PRIVATE_MEETING_ID=${MEETINGS.private}`,
    `E2E_M8_W2_MEETING_ID=${MEETINGS.w2}`,
    `E2E_M8_CALENDAR_MEETING_ID=${MEETINGS.calendar}`,
    `E2E_M8_RECAP_MEETING_ID=${MEETINGS.recap}`,
    `E2E_M8_ICAL_UID=${E2E_M8_ICAL_UID}`,
    `E2E_M8_MEMBER_EMAIL=${USERS.w1Member.email}`,
  ]

  await mkdir(path.dirname(path.resolve(file)), { recursive: true })
  await writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 })
  console.log(`Seeded ${meetings.length} meetings in 2 workspaces (3 users).`)
  console.log(`Test credentials written to ${file}.`)
  await pool.end()
}

async function deliver(workspaceId: string, visibility: MeetingVisibility | undefined, eventName: PlatformEventName, data: Record<string, unknown>) {
  try {
    await deliverWebhookEvent({
      eventName,
      data: platformEventData(workspaceId, platformEventPayload(eventName, data), visibility),
      workspaceId,
    })
  } catch {
    // Same as the processor: webhook delivery never fails the run.
  }
  // wait: the script exits right after, so a fire-and-forget enqueue never lands.
  await enqueueIntegrationEvent({
    workspaceId,
    eventName,
    eventId: `evt_${randomUUID()}`,
    meetingId: String(data.meetingId ?? ""),
    ...(typeof data.actionItemId === "string" ? { actionItemId: data.actionItemId } : {}),
  }, undefined, { wait: true }).catch((error: unknown) => {
    console.warn(`Integration enqueue failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

async function complete(meetingId: string) {
  const pool = getDatabasePool()
  const found = await pool.query(
    "select id, title, workspace_id, visibility from meetings where id = $1",
    [meetingId]
  )
  const row = found.rows[0] as { id: string; title: string; workspace_id: string; visibility: MeetingVisibility | null } | undefined

  if (!row) throw new Error("Meeting not found")
  const visibility = row.visibility ?? undefined
  const tags = await pool.query("select t.name from meeting_tags mt join tags t on t.id = mt.tag_id where mt.meeting_id = $1", [meetingId])
  const actions = await pool.query("select id, title, owner, priority from action_items where meeting_id = $1 order by id", [meetingId])

  await deliver(row.workspace_id, visibility, "summary.created", {
    meetingId,
    title: row.title,
    tags: tags.rows.map((tag: { name: string }) => tag.name),
  })
  for (const item of actions.rows as { id: string; title: string; owner: string | null; priority: string }[]) {
    await deliver(row.workspace_id, visibility, "action_item.created", {
      meetingId,
      actionItemId: item.id,
      title: item.title,
      owner: item.owner ?? undefined,
      priority: item.priority,
    })
  }
  await deliver(row.workspace_id, visibility, "meeting.completed", { meetingId, title: row.title })
  console.log(`Completion events fired for 1 meeting (${actions.rows.length} action items).`)
  await pool.end()
}

async function main() {
  const index = process.argv.indexOf("--complete")

  if (index >= 0) {
    const meetingId = process.argv[index + 1]

    if (!meetingId) throw new Error("Usage: integrations:e2e-seed --complete <meetingId>")

    return complete(meetingId)
  }

  return seed()
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
