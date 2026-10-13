/**
 * PGlite with every migration (001–030) for M9 Package C tests, plus a
 * W1/W2 fixture: W1 owner, admin, member and viewer; a W2 owner; meetings in
 * both workspaces including one private to the W1 member. Returns undefined
 * when PGlite cannot load (callers skip).
 */
import { listMigrationFiles } from "@/lib/db/migrations"

/** Structurally a `Queryable` (lib/db/client.ts), with typed rows for tests. */
export type PgLike = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
  exec(sql: string): Promise<unknown>
  close(): Promise<void>
}

export async function createM9Database(): Promise<PgLike | undefined> {
  let db: PgLike

  try {
    const { PGlite } = await import("@electric-sql/pglite")
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm")

    db = (await PGlite.create({ extensions: { pg_trgm } })) as unknown as PgLike
  } catch {
    return undefined
  }

  for (const migration of listMigrationFiles("db/migrations")) {
    await db.exec(migration.sql)
  }

  return db
}

export const W1 = "ws_1"
export const W2 = "ws_2"

export const USERS = {
  owner: { id: "usr_owner", email: "owner@w1.example", name: "Owner" },
  admin: { id: "usr_admin", email: "admin@w1.example", name: "Admin" },
  member: { id: "usr_member", email: "member@w1.example", name: "Member" },
  viewer: { id: "usr_viewer", email: "viewer@w1.example", name: "Viewer" },
  w2: { id: "usr_w2", email: "owner@w2.example", name: "W2 owner" },
} as const

/** Users, workspaces and memberships only. */
export async function seedM9Workspaces(db: PgLike): Promise<void> {
  await db.exec(`
    insert into workspaces (id, name, slug, created_at) values
      ('${W1}', 'W1', 'w1', '2026-09-01T00:00:00Z'),
      ('${W2}', 'W2', 'w2', '2026-09-01T00:00:00Z')
      on conflict do nothing;
    insert into users (id, email, name) values
      ('usr_owner', 'owner@w1.example', 'Owner'),
      ('usr_admin', 'admin@w1.example', 'Admin'),
      ('usr_member', 'member@w1.example', 'Member'),
      ('usr_viewer', 'viewer@w1.example', 'Viewer'),
      ('usr_w2', 'owner@w2.example', 'W2 owner')
      on conflict do nothing;
    insert into memberships (workspace_id, user_id, role) values
      ('${W1}', 'usr_owner', 'owner'),
      ('${W1}', 'usr_admin', 'admin'),
      ('${W1}', 'usr_member', 'member'),
      ('${W1}', 'usr_viewer', 'viewer'),
      ('${W2}', 'usr_w2', 'owner')
      on conflict do nothing;
  `)
}

/**
 * Analytics fixture (all in October 2026, Asia/Jerusalem):
 * - m_a1 (owner, workspace, 60 min, tags sales+hr, analytics: owner 30 min,
 *   admin 20 min, an unconfirmed speaker 10 min; 2 action items, 1 done)
 * - m_a2 (admin, workspace, 30 min, tag sales, analytics: owner 10 min, admin 20 min)
 * - m_a3 (owner, link, 30 min, no analytics; 1 overdue action item)
 * - m_a4 (admin, workspace, 15 min, analytics: owner 5 min, admin 5 min, member 5 min)
 * - m_priv (member, private, 120 min, tag secret, analytics: member 120 min, 5 action items)
 * - m_w2 (W2, workspace, 45 min, tag sales, 1 action item)
 * - m_old (owner, workspace, 2026-01-01: outside the October range)
 */
export async function seedM9Analytics(db: PgLike): Promise<void> {
  await db.exec(`
    insert into meetings (id, title, source, language, status, started_at, workspace_id, owner_user_id, visibility, duration_ms) values
      ('m_a1', 'Sales sync', 'upload', 'he', 'completed', '2026-10-05T07:00:00Z', '${W1}', 'usr_owner', 'workspace', 3600000),
      ('m_a2', 'Pipeline review', 'upload', 'en', 'completed', '2026-10-12T21:30:00Z', '${W1}', 'usr_admin', 'workspace', 1800000),
      ('m_a3', 'Board prep', 'upload', 'he', 'completed', '2026-10-20T08:00:00Z', '${W1}', 'usr_owner', 'link', 1800000),
      ('m_a4', 'Standup', 'upload', 'he', 'completed', '2026-10-21T06:00:00Z', '${W1}', 'usr_admin', 'workspace', 900000),
      ('m_priv', 'Secret 1:1', 'upload', 'he', 'completed', '2026-10-15T09:00:00Z', '${W1}', 'usr_member', 'private', 7200000),
      ('m_w2', 'W2 meeting', 'upload', 'he', 'completed', '2026-10-10T09:00:00Z', '${W2}', 'usr_w2', 'workspace', 2700000),
      ('m_old', 'Old meeting', 'upload', 'he', 'completed', '2026-01-01T09:00:00Z', '${W1}', 'usr_owner', 'workspace', 600000)
      on conflict do nothing;

    insert into meeting_participants (id, meeting_id, name, email) values
      ('mp_1', 'm_a1', 'Owner', 'owner@w1.example'),
      ('mp_2', 'm_a1', 'Member', 'member@w1.example'),
      ('mp_3', 'm_priv', 'Member', 'member@w1.example')
      on conflict do nothing;

    insert into speaker_profiles (id, workspace_id, display_name, user_id) values
      ('sp_owner', '${W1}', 'Owner', 'usr_owner'),
      ('sp_admin', '${W1}', 'Admin', 'usr_admin'),
      ('sp_member', '${W1}', 'Member', 'usr_member')
      on conflict do nothing;

    insert into speakers (id, meeting_id, label, workspace_id, profile_id, mapping_status) values
      ('spk_a1_o', 'm_a1', 'S1', '${W1}', 'sp_owner', 'confirmed'),
      ('spk_a1_a', 'm_a1', 'S2', '${W1}', 'sp_admin', 'confirmed'),
      ('spk_a1_x', 'm_a1', 'S3', '${W1}', null, 'unmapped'),
      ('spk_a2_o', 'm_a2', 'S1', '${W1}', 'sp_owner', 'confirmed'),
      ('spk_a2_a', 'm_a2', 'S2', '${W1}', 'sp_admin', 'confirmed'),
      ('spk_a4_o', 'm_a4', 'S1', '${W1}', 'sp_owner', 'confirmed'),
      ('spk_a4_a', 'm_a4', 'S2', '${W1}', 'sp_admin', 'confirmed'),
      ('spk_a4_m', 'm_a4', 'S3', '${W1}', 'sp_member', 'confirmed'),
      ('spk_p_m', 'm_priv', 'S1', '${W1}', 'sp_member', 'confirmed')
      on conflict do nothing;

    insert into meeting_analytics (meeting_id, workspace_id, version, transcript_hash, metrics) values
      ('m_a1', '${W1}', 2, 'h1', '{"speakers":[{"speakerId":"spk_a1_o","label":"S1","talkTimeMs":1800000},{"speakerId":"spk_a1_a","label":"S2","talkTimeMs":1200000},{"speakerId":"spk_a1_x","label":"S3","talkTimeMs":600000}]}'),
      ('m_a2', '${W1}', 2, 'h2', '{"speakers":[{"speakerId":"spk_a2_o","label":"S1","talkTimeMs":600000},{"speakerId":"spk_a2_a","label":"S2","talkTimeMs":1200000}]}'),
      ('m_a4', '${W1}', 2, 'h4', '{"speakers":[{"speakerId":"spk_a4_o","label":"S1","talkTimeMs":300000},{"speakerId":"spk_a4_a","label":"S2","talkTimeMs":300000},{"speakerId":"spk_a4_m","label":"S3","talkTimeMs":300000}]}'),
      ('m_priv', '${W1}', 2, 'hp', '{"speakers":[{"speakerId":"spk_p_m","label":"S1","talkTimeMs":7200000}]}')
      on conflict do nothing;

    insert into tags (id, name, workspace_id) values
      ('tag_sales', 'sales', '${W1}'), ('tag_hr', 'hr', '${W1}'), ('tag_secret', 'secret', '${W1}'),
      ('tag_w2', 'sales', '${W2}')
      on conflict do nothing;
    insert into meeting_tags (meeting_id, tag_id) values
      ('m_a1', 'tag_sales'), ('m_a1', 'tag_hr'), ('m_a2', 'tag_sales'), ('m_priv', 'tag_secret'), ('m_w2', 'tag_w2')
      on conflict do nothing;

    insert into action_items (id, meeting_id, title, status, workspace_id, owner_user_id, created_at, completed_at, due_on) values
      ('ai_1', 'm_a1', 'Send deck', 'done', '${W1}', 'usr_owner', '2026-10-05T08:00:00Z', '2026-10-06T08:00:00Z', null),
      ('ai_2', 'm_a1', 'Book room', 'open', '${W1}', 'usr_admin', '2026-10-05T08:00:00Z', null, null),
      ('ai_3', 'm_a3', 'Prepare board', 'open', '${W1}', 'usr_owner', '2026-10-20T09:00:00Z', null, '2026-10-21'),
      ('ai_p1', 'm_priv', 'P1', 'open', '${W1}', 'usr_member', '2026-10-15T10:00:00Z', null, '2026-10-16'),
      ('ai_p2', 'm_priv', 'P2', 'open', '${W1}', 'usr_member', '2026-10-15T10:00:00Z', null, null),
      ('ai_p3', 'm_priv', 'P3', 'done', '${W1}', 'usr_member', '2026-10-15T10:00:00Z', '2026-10-15T11:00:00Z', null),
      ('ai_p4', 'm_priv', 'P4', 'done', '${W1}', 'usr_member', '2026-10-15T10:00:00Z', '2026-10-15T12:00:00Z', null),
      ('ai_p5', 'm_priv', 'P5', 'open', '${W1}', 'usr_member', '2026-10-15T10:00:00Z', null, null),
      ('ai_w2', 'm_w2', 'W2', 'open', '${W2}', 'usr_w2', '2026-10-10T10:00:00Z', null, null)
      on conflict do nothing;

    insert into contexts (id, name, workspace_id) values
      ('ctx_w1', 'Room W1', '${W1}'), ('ctx_w2', 'Room W2', '${W2}')
      on conflict do nothing;
    insert into meeting_contexts (meeting_id, context_id) values
      ('m_a1', 'ctx_w1'), ('m_priv', 'ctx_w1'), ('m_w2', 'ctx_w2')
      on conflict do nothing;
  `)
}
