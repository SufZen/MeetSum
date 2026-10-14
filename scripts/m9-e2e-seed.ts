/**
 * M9 browser e2e seed (docs/parity/m9.md C4; Acceptance 17 and 18).
 *
 *   npm run m9:e2e-seed
 *
 * Needs DATABASE_URL (migrated, 030 applied) on localhost and
 * MEETSUM_SESSION_SECRET (the app's). Refuses any non-local database or base
 * URL (security check 9). Seeds, with ids prefixed `e2e_m9_` (re-running
 * replaces them):
 * - W1 with an owner, an admin and a member; W2 with an owner; W3, a fresh
 *   workspace (no meetings) whose owner is redirected to onboarding;
 * - 12 W1 meetings over the last 12 days: Hebrew, English and code-switched
 *   ones with transcripts (one multi-segment turn for the turn-undo check),
 *   summaries, tags, action items and analytics rows with confirmed
 *   speakers; one is private to the member (2 h of talk time, 5 action items);
 * - a W2 meeting;
 * - notifications of every kind for the admin, plus a stale row that points
 *   at the member's private meeting (the read-time re-check must blank it);
 * - an open share link and a password-protected one (scrypt, the B4 format).
 * Ids, expected numbers, session cookies and the share password go to
 * E2E_ENV_FILE (default `.secrets/e2e-m9.env`, gitignored), never to stdout.
 */
import { randomBytes, scryptSync } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { createSessionCookie, getSessionSecret } from "@/lib/auth/session"
import { getDatabasePool, type Queryable } from "@/lib/db/client"
import { suiteEnvFile } from "@/scripts/e2e/env-file"

const PREFIX = "e2e_m9_"
const W1 = `${PREFIX}ws_1`
const W2 = `${PREFIX}ws_2`
const W3 = `${PREFIX}ws_3`
const DAY = 86_400_000

const USERS = {
  owner: { id: `${PREFIX}owner`, email: "m9-owner@example.test", name: "דנה כהן", workspace: W1, role: "owner" },
  admin: { id: `${PREFIX}admin`, email: "m9-admin@example.test", name: "Rui Santos", workspace: W1, role: "admin" },
  member: { id: `${PREFIX}member`, email: "m9-member@example.test", name: "נועה לוי", workspace: W1, role: "member" },
  w2: { id: `${PREFIX}w2_owner`, email: "m9-w2-owner@example.test", name: "W2 Owner", workspace: W2, role: "owner" },
  fresh: { id: `${PREFIX}fresh_owner`, email: "m9-fresh@example.test", name: "אורי בן דוד", workspace: W3, role: "owner" },
} as const

type User = (typeof USERS)[keyof typeof USERS]

type SeedMeeting = {
  id: string
  workspaceId: string
  owner: User
  visibility: "workspace" | "private" | "link"
  title: string
  language: "he" | "en" | "mixed"
  daysAgo: number
  minutes: number
  tags: string[]
  /** [speaker user (or null = unconfirmed), talk minutes] */
  talk: Array<[User | null, number]>
  actions: Array<{ title: string; owner?: User; done?: boolean; dueDaysAgo?: number }>
  transcript?: Array<{ speaker: number; text: string; turn: number }>
  overview?: string
}

/** Refuses anything but a local database and base URL (security check 9). */
export function assertLocalTarget(env: NodeJS.ProcessEnv = process.env): void {
  const local = (value: string | undefined, name: string) => {
    if (!value) return
    let host: string

    try {
      host = new URL(value).hostname
    } catch {
      throw new Error(`${name} is not a URL`)
    }
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
      throw new Error(`${name} must point at localhost (refusing to seed a non-local target)`)
    }
  }

  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  local(env.DATABASE_URL, "DATABASE_URL")
  local(env.E2E_BASE_URL, "E2E_BASE_URL")
}

/** `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>` (docs/parity/m9.md B4). */
export function hashSharePasswordForSeed(password: string): string {
  const N = 2 ** 15
  const r = 8
  const p = 1
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 })

  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`
}

function seededMeetings(): SeedMeeting[] {
  const { owner, admin, member, w2 } = USERS
  const filler = (index: number): SeedMeeting => ({
    id: `${PREFIX}m_${String(index).padStart(2, "0")}`,
    workspaceId: W1,
    owner: index % 2 ? admin : owner,
    visibility: "workspace",
    title: index % 3 ? `סנכרון שבועי ${index}` : `Weekly sync ${index}`,
    language: index % 3 ? "he" : "en",
    daysAgo: index,
    minutes: 30,
    tags: index % 2 ? ["מכירות"] : ["גיוס"],
    talk: [
      [owner, 10],
      [admin, 10],
    ],
    actions: [{ title: `משימה ${index}`, owner: admin, done: index % 2 === 0 }],
  })

  return [
    {
      id: `${PREFIX}m_hebrew`,
      workspaceId: W1,
      owner,
      visibility: "workspace",
      title: "עדכון סטטוס עסקה — Lisboa Riverside",
      language: "he",
      daysAgo: 1,
      minutes: 60,
      tags: ["מכירות", "נדל״ן"],
      talk: [
        [owner, 30],
        [admin, 20],
        [null, 10],
      ],
      actions: [
        { title: "לשלוח את טיוטת ההסכם לעורך הדין", owner: admin },
        { title: "לתאם סיור באתר", owner, done: true },
        { title: "לעדכן את המשקיעים", owner: admin, dueDaysAgo: 3 },
      ],
      transcript: [
        { speaker: 0, turn: 0, text: "בוקר טוב, נתחיל בעדכון על Lisboa Riverside." },
        { speaker: 0, turn: 0, text: "הבנק אישר את המימון בתנאים שסיכמנו." },
        { speaker: 0, turn: 0, text: "נשארה רק הבדיקה המשפטית." },
        { speaker: 1, turn: 1, text: "מצוין, אז נקדם את החתימה לשבוע הבא." },
      ],
      overview: "הבנק אישר את המימון לעסקת Lisboa Riverside; החתימה תקודם לשבוע הבא.",
    },
    {
      id: `${PREFIX}m_english`,
      workspaceId: W1,
      owner: admin,
      visibility: "workspace",
      title: "Partner pipeline review",
      language: "en",
      daysAgo: 2,
      minutes: 45,
      tags: ["מכירות"],
      talk: [
        [admin, 25],
        [owner, 15],
      ],
      actions: [{ title: "Send the revised forecast", owner: admin }],
      transcript: [
        { speaker: 0, turn: 0, text: "Let's review the partner pipeline for Q4." },
        { speaker: 1, turn: 1, text: "Two deals moved to negotiation this week." },
      ],
      overview: "Two partner deals moved to negotiation; the forecast will be revised.",
    },
    {
      id: `${PREFIX}m_mixed`,
      workspaceId: W1,
      owner,
      visibility: "link",
      title: "סקירת Roadmap עם צוות ה-Product",
      language: "mixed",
      daysAgo: 3,
      minutes: 40,
      tags: ["מוצר"],
      talk: [
        [owner, 20],
        [member, 10],
      ],
      actions: [{ title: "לפתוח ticket ב-Jira על ה-onboarding", owner: member }],
      transcript: [
        { speaker: 0, turn: 0, text: "בואו נעבור על ה-Roadmap של Q1." },
        { speaker: 1, turn: 1, text: "ה-onboarding צריך עוד sprint אחד." },
      ],
      overview: "הצוות סקר את ה-Roadmap של Q1; ה-onboarding דורש עוד sprint.",
    },
    {
      id: `${PREFIX}m_private`,
      workspaceId: W1,
      owner: member,
      visibility: "private",
      title: "שיחה פרטית על תקציב — סודי",
      language: "he",
      daysAgo: 4,
      minutes: 120,
      tags: ["סודי"],
      talk: [[member, 120]],
      actions: Array.from({ length: 5 }, (_, index) => ({ title: `פריט פרטי ${index + 1}`, owner: member })),
      overview: "שיחה פרטית על התקציב לרבעון הבא.",
    },
    ...Array.from({ length: 8 }, (_, index) => filler(index + 5)),
    {
      id: `${PREFIX}m_w2`,
      workspaceId: W2,
      owner: w2,
      visibility: "workspace",
      title: "Workspace 2 meeting",
      language: "en",
      daysAgo: 2,
      minutes: 30,
      tags: ["מכירות"],
      talk: [[w2, 20]],
      actions: [{ title: "W2 follow-up", owner: w2 }],
    },
  ]
}

/**
 * Seeds `db` and returns the env-file lines (ids, expected numbers, test
 * session cookies). Exported for the PGlite test.
 */
export async function seedM9E2E(db: Queryable, options: { secret: string; now?: number }): Promise<string[]> {
  const secret = options.secret
  const q = (text: string, values?: unknown[]) => db.query(text, values)
  const now = options.now ?? Date.now()
  const meetings = seededMeetings()
  const iso = (ms: number) => new Date(ms).toISOString()

  // Replace previous runs (children cascade from meetings and workspaces).
  await q("delete from notifications where user_id like 'e2e\\_m9\\_%'")
  await q("delete from onboarding_progress where workspace_id like 'e2e\\_m9\\_%'")
  await q("delete from meetings where workspace_id like 'e2e\\_m9\\_%'")
  await q("delete from speaker_profiles where workspace_id like 'e2e\\_m9\\_%'")
  await q("delete from tags where workspace_id like 'e2e\\_m9\\_%'")
  await q("delete from invitations where workspace_id like 'e2e\\_m9\\_%'")
  await q("delete from memberships where workspace_id like 'e2e\\_m9\\_%'")
  await q("update users set default_workspace_id = null where id like 'e2e\\_m9\\_%'")
  await q("delete from workspaces where id like 'e2e\\_m9\\_%'")

  for (const user of Object.values(USERS)) {
    await q(
      `insert into users (id, email, name) values ($1, $2, $3)
       on conflict (id) do update set name = excluded.name, preferences = '{}'::jsonb, locale = null`,
      [user.id, user.email, user.name]
    )
  }
  for (const [id, name, ageDays] of [
    [W1, "Acme ישראל", 60],
    [W2, "Other Co", 60],
    [W3, "סטודיו חדש", 0],
  ] as const) {
    await q("insert into workspaces (id, name, slug, created_at) values ($1, $2, $1, $3)", [id, name, iso(now - ageDays * DAY)])
  }
  for (const user of Object.values(USERS)) {
    await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [user.workspace, user.id, user.role])
    await q("update users set default_workspace_id = $2 where id = $1", [user.id, user.workspace])
  }
  for (const user of [USERS.owner, USERS.admin, USERS.member, USERS.w2]) {
    await q("insert into speaker_profiles (id, workspace_id, display_name, email, user_id) values ($1, $2, $3, $4, $5)", [
      `${user.id}_profile`,
      user.workspace,
      user.name,
      user.email,
      user.id,
    ])
  }

  const tagIds = new Map<string, string>()

  for (const meeting of meetings) {
    const startedAt = now - meeting.daysAgo * DAY - 2 * 3_600_000

    await q(
      `insert into meetings (id, title, source, language, status, started_at, workspace_id, owner_user_id, visibility,
         duration_ms, transcript_version, title_source)
       values ($1, $2, 'upload', $3, 'completed', $4, $5, $6, $7, $8, 1, 'user')`,
      [meeting.id, meeting.title, meeting.language, iso(startedAt), meeting.workspaceId, meeting.owner.id, meeting.visibility, meeting.minutes * 60_000]
    )

    const people = [...new Set([meeting.owner, ...meeting.talk.map(([user]) => user).filter((user): user is User => Boolean(user))])]

    for (const [index, person] of people.entries()) {
      await q("insert into meeting_participants (id, meeting_id, name, email) values ($1, $2, $3, $4)", [
        `${meeting.id}_p${index}`,
        meeting.id,
        person.name,
        person.email,
      ])
    }

    for (const tag of meeting.tags) {
      const key = `${meeting.workspaceId}:${tag}`
      let tagId = tagIds.get(key)

      if (!tagId) {
        tagId = `${PREFIX}tag_${tagIds.size}`
        tagIds.set(key, tagId)
        await q("insert into tags (id, name, workspace_id) values ($1, $2, $3)", [tagId, tag, meeting.workspaceId])
      }
      await q("insert into meeting_tags (meeting_id, tag_id) values ($1, $2)", [meeting.id, tagId])
    }

    const speakers = meeting.talk.map(([user, minutes], index) => ({
      id: `${meeting.id}_spk${index}`,
      user,
      minutes,
      label: `Speaker ${index + 1}`,
    }))

    for (const speaker of speakers) {
      await q(
        `insert into speakers (id, meeting_id, label, display_name, workspace_id, profile_id, mapping_status, talk_time_ms)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          speaker.id,
          meeting.id,
          speaker.label,
          speaker.user?.name ?? null,
          meeting.workspaceId,
          speaker.user ? `${speaker.user.id}_profile` : null,
          speaker.user ? "confirmed" : "unmapped",
          speaker.minutes * 60_000,
        ]
      )
    }

    // Most meetings have analytics; the oldest filler does not (honest coverage line).
    if (meeting.daysAgo < 12) {
      const total = speakers.reduce((sum, speaker) => sum + speaker.minutes * 60_000, 0)

      await q(
        `insert into meeting_analytics (meeting_id, workspace_id, version, transcript_hash, metrics)
         values ($1, $2, 2, $3, $4::jsonb)`,
        [
          meeting.id,
          meeting.workspaceId,
          `seed-${meeting.id}`,
          JSON.stringify({
            basis: "text",
            totalTalkTimeMs: total,
            totalWords: 0,
            totalQuestions: 0,
            fillerPer100Words: 0,
            interruptions: 0,
            speakers: speakers.map((speaker) => ({
              speakerId: speaker.id,
              label: speaker.label,
              talkTimeMs: speaker.minutes * 60_000,
              share: total ? (speaker.minutes * 60_000) / total : 0,
              wordCount: 0,
              wpm: 0,
              longestMonologueMs: 0,
              questions: 0,
              fillerPer100Words: 0,
              interruptions: 0,
            })),
          }),
        ]
      )
    }

    let offset = 0

    for (const [index, segment] of (meeting.transcript ?? []).entries()) {
      await q(
        `insert into transcript_segments (id, meeting_id, speaker_id, start_ms, end_ms, text, language, turn_index)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          `${meeting.id}_s${index}`,
          meeting.id,
          speakers[segment.speaker]?.id ?? null,
          offset,
          offset + 6_000,
          segment.text,
          meeting.language === "mixed" ? "he" : meeting.language,
          segment.turn,
        ]
      )
      offset += 6_000
    }

    if (meeting.overview) {
      await q("insert into summaries (id, meeting_id, overview, language) values ($1, $2, $3, $4)", [
        `${meeting.id}_summary`,
        meeting.id,
        meeting.overview,
        meeting.language === "en" ? "en" : "he",
      ])
    }

    for (const [index, action] of meeting.actions.entries()) {
      const created = startedAt + 3_600_000

      await q(
        `insert into action_items (id, meeting_id, title, status, workspace_id, owner_user_id, created_at, completed_at, due_on)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          `${meeting.id}_a${index}`,
          meeting.id,
          action.title,
          action.done ? "done" : "open",
          meeting.workspaceId,
          action.owner?.id ?? null,
          iso(created),
          action.done ? iso(created + 5 * 3_600_000) : null,
          action.dueDaysAgo !== undefined ? iso(now - action.dueDaysAgo * DAY).slice(0, 10) : null,
        ]
      )
    }
  }

  // Notifications for the admin: one of every kind, newest first, plus a
  // stale row about the member's private meeting (the bell must blank it).
  const hebrew = `${PREFIX}m_hebrew`
  const privateId = `${PREFIX}m_private`
  const invitationId = `${PREFIX}inv_admin_to_w2`

  await q(
    `insert into invitations (id, workspace_id, email, role, token_hash, invited_by_user_id, expires_at)
     values ($1, $2, $3, 'member', $4, $5, $6)`,
    [invitationId, W2, USERS.admin.email, `seed-${randomBytes(16).toString("hex")}`, USERS.w2.id, iso(now + 7 * DAY)]
  )

  const notifications: Array<[string, string, Record<string, unknown>, string | null, string | null, string]> = [
    ["mention", W1, { meetingId: hebrew, commentId: `${PREFIX}c1`, startMs: 6_000 }, hebrew, USERS.owner.id, "mn:seed1"],
    ["reply", W1, { meetingId: hebrew, commentId: `${PREFIX}c2`, parentId: `${PREFIX}c1` }, hebrew, USERS.member.id, "rp:seed2"],
    ["task_assigned", W1, { meetingId: hebrew, actionItemId: `${hebrew}_a0` }, hebrew, USERS.owner.id, "ta:seed3"],
    ["integration_reauth", W1, { connectionId: `${PREFIX}conn`, provider: "slack" }, null, null, "ir:seed4"],
    ["invited", W2, { invitationId, workspaceId: W2, role: "member" }, null, USERS.w2.id, `inv:${invitationId}`],
    ["meeting_processed", W1, { meetingId: `${PREFIX}m_english`, transcriptVersion: 1 }, `${PREFIX}m_english`, null, "mp:seed6"],
    ["meeting_failed", W1, { meetingId: `${PREFIX}m_mixed`, jobId: `${PREFIX}job` }, `${PREFIX}m_mixed`, null, "mf:seed7"],
    ["bot_blocked", W1, { meetingId: hebrew, sessionId: `${PREFIX}bot` }, hebrew, null, "bb:seed8"],
    ["meeting_processed", W1, { meetingId: privateId, transcriptVersion: 1 }, privateId, null, "mp:seed9"],
    ["share_attempts", W1, { meetingId: hebrew, shareId: `${PREFIX}share_seed`, failures: 50 }, hebrew, null, "sa:seed10"],
  ]

  for (const [index, [kind, workspaceId, payload, meetingId, actor, dedupe]] of notifications.entries()) {
    await q(
      `insert into notifications (id, workspace_id, user_id, kind, payload, meeting_id, actor_user_id, dedupe_key, created_at)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
      [`${PREFIX}ntf_${index}`, workspaceId, USERS.admin.id, kind, JSON.stringify(payload), meetingId, actor, dedupe, iso(now - (index + 1) * 600_000)]
    )
  }

  // Shares of the Hebrew meeting: open and password-protected.
  const sharePassword = `m9-${randomBytes(6).toString("hex")}`
  const openToken = `${PREFIX}${randomBytes(12).toString("hex")}`
  const protectedToken = `${PREFIX}${randomBytes(12).toString("hex")}`

  await q("update meetings set visibility = 'link' where id = $1", [hebrew])
  await q("insert into meeting_shares (id, meeting_id, token, created_by) values ($1, $2, $3, $4)", [`${PREFIX}share_open`, hebrew, openToken, USERS.owner.id])
  await q("insert into meeting_shares (id, meeting_id, token, created_by, password_hash) values ($1, $2, $3, $4, $5)", [
    `${PREFIX}share_protected`,
    hebrew,
    protectedToken,
    USERS.owner.id,
    hashSharePasswordForSeed(sharePassword),
  ])

  // Expected dashboard numbers (last 90 days; the private meeting is the member's).
  const w1 = meetings.filter((meeting) => meeting.workspaceId === W1)
  const shared = w1.filter((meeting) => meeting.visibility !== "private")
  const cookie = (user: User) => createSessionCookie({ userId: user.id, email: user.email, name: user.name }, { secret }).value
  return [
    "# Generated by npm run m9:e2e-seed. Test-only session cookies; do not commit.",
    `E2E_M9_OWNER_SESSION=${cookie(USERS.owner)}`,
    `E2E_M9_ADMIN_SESSION=${cookie(USERS.admin)}`,
    `E2E_M9_MEMBER_SESSION=${cookie(USERS.member)}`,
    `E2E_M9_W2_SESSION=${cookie(USERS.w2)}`,
    `E2E_M9_FRESH_SESSION=${cookie(USERS.fresh)}`,
    `E2E_M9_W1_WORKSPACE_ID=${W1}`,
    `E2E_M9_W2_WORKSPACE_ID=${W2}`,
    `E2E_M9_W3_WORKSPACE_ID=${W3}`,
    `E2E_M9_HEBREW_MEETING_ID=${hebrew}`,
    `E2E_M9_ENGLISH_MEETING_ID=${PREFIX}m_english`,
    `E2E_M9_MIXED_MEETING_ID=${PREFIX}m_mixed`,
    `E2E_M9_PRIVATE_MEETING_ID=${privateId}`,
    `E2E_M9_PRIVATE_MEETING_TITLE=${w1.find((meeting) => meeting.id === privateId)?.title ?? ""}`,
    `E2E_M9_TENTH_MEETING_ID=${PREFIX}m_10`,
    `E2E_M9_ADMIN_UNREAD=${notifications.length}`,
    `E2E_M9_ADMIN_MEETINGS=${shared.length}`,
    `E2E_M9_MEMBER_MEETINGS=${w1.length}`,
    `E2E_M9_ADMIN_COVERAGE_WITH=${shared.filter((meeting) => meeting.daysAgo < 12).length}`,
    `E2E_M9_SHARE_TOKEN=${openToken}`,
    `E2E_M9_PROTECTED_SHARE_TOKEN=${protectedToken}`,
    `E2E_M9_SHARE_PASSWORD=${sharePassword}`,
  ]
}

async function main() {
  assertLocalTarget()

  const pool = getDatabasePool()
  const lines = await seedM9E2E(pool, { secret: getSessionSecret() })
  const file = suiteEnvFile("m9")

  await mkdir(path.dirname(path.resolve(file)), { recursive: true })
  await writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 })
  console.log(`Seeded the M9 fixture (3 workspaces, ${Object.keys(USERS).length} users).`)
  console.log(`Test credentials written to ${file}.`)
  await pool.end()
}

if (process.argv[1] && /m9-e2e-seed/.test(process.argv[1])) {
  main().catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : "Seed failed")
    await getDatabasePool().end().catch(() => undefined)
    process.exit(1)
  })
}
