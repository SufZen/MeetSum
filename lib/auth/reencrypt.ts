/**
 * Token-key rotation (docs/parity/m10.md, R10): rewrites every stored secret
 * that is not under the current key. Used by `scripts/reencrypt-tokens.ts`.
 *
 * - Dry run unless `apply` is true: rows are locked and checked, nothing is
 *   written.
 * - Each row is handled in its own transaction under `select … for update`.
 * - `integration_connections` updates are conditional on the generation that
 *   was read (the M8 CAS), and the generation is not bumped: a concurrent
 *   refresh that already wrote new tokens is never clobbered, and a refresh
 *   that started before us still lands (its write is under the current key).
 * - Values are never returned or logged; the report holds counts only.
 */
import type { Queryable } from "@/lib/db/client"
import { decryptSecret, encryptSecret, secretNeedsReencryption } from "@/lib/auth/secret-crypto"

type Row = Record<string, unknown>

export type SecretColumn = {
  column: string
  /** Row-bound (v2) AAD for this column, or undefined for unbound (v1) secrets. */
  aad?: (row: Row) => string
}

export type SecretTarget = {
  table: string
  columns: SecretColumn[]
  /** Extra columns the AAD needs. */
  select?: string[]
  /** CAS column (integration_connections.token_generation). */
  generation?: string
}

export const SECRET_TARGETS: SecretTarget[] = [
  { table: "google_identities", columns: [{ column: "oauth_refresh_token" }] },
  { table: "webhook_subscriptions", columns: [{ column: "secret_ciphertext" }] },
  { table: "bot_sessions", columns: [{ column: "passcode_enc" }] },
  {
    table: "integration_connections",
    select: ["workspace_id"],
    generation: "token_generation",
    columns: [
      { column: "access_token_enc", aad: (row) => `${row.workspace_id}:${row.id}:access_token` },
      { column: "refresh_token_enc", aad: (row) => `${row.workspace_id}:${row.id}:refresh_token` },
    ],
  },
  // integration_oauth_states.code_verifier_enc is left alone: states expire
  // within minutes, so a rotation only needs the old key kept for that long.
]

export type TableReport = {
  table: string
  rows: number
  current: number
  rewritten: number
  failed: number
  skippedConcurrent: number
}

export type ReencryptOptions = {
  apply: boolean
  targets?: SecretTarget[]
}

type Transactional = Queryable & { connect?: () => Promise<Queryable & { release: () => void }> }

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`invalid identifier: ${name}`)

  return name
}

export async function reencryptStoredSecrets(db: Transactional, options: ReencryptOptions): Promise<TableReport[]> {
  const reports: TableReport[] = []

  for (const target of options.targets ?? SECRET_TARGETS) {
    const table = ident(target.table)
    const columns = target.columns.map((entry) => ident(entry.column))
    const extra = [...(target.select ?? []), ...(target.generation ? [target.generation] : [])].map(ident)
    const report: TableReport = { table, rows: 0, current: 0, rewritten: 0, failed: 0, skippedConcurrent: 0 }
    const ids = await db.query(
      `select id from ${table} where ${columns.map((column) => `${column} is not null`).join(" or ")} order by id`
    )

    for (const { id } of ids.rows as Array<{ id: string }>) {
      report.rows += 1
      const client = db.connect ? await db.connect() : db

      try {
        await client.query("begin")
        const locked = await client.query(
          `select id, ${[...columns, ...extra].join(", ")} from ${table} where id = $1 for update`,
          [id]
        )
        const row = locked.rows[0] as Row | undefined

        if (!row) {
          await client.query("rollback")
          continue
        }

        const updates: Array<[string, string]> = []
        let failed = false

        for (const entry of target.columns) {
          const value = row[entry.column]

          if (typeof value !== "string" || !secretNeedsReencryption(value)) continue
          try {
            const aad = entry.aad?.(row)

            updates.push([entry.column, encryptSecret(decryptSecret(value, aad), aad)])
          } catch {
            failed = true
          }
        }

        if (failed) {
          report.failed += 1
          await client.query("rollback")
          continue
        }
        if (updates.length === 0) {
          report.current += 1
          await client.query("rollback")
          continue
        }
        if (!options.apply) {
          report.rewritten += 1
          await client.query("rollback")
          continue
        }

        const values: unknown[] = [id, ...updates.map(([, value]) => value)]
        let condition = "id = $1"

        if (target.generation) {
          values.push(row[target.generation])
          condition += ` and ${ident(target.generation)} = $${values.length}`
        }

        const result = (await client.query(
          `update ${table} set ${updates.map(([column], index) => `${column} = $${index + 2}`).join(", ")} where ${condition} returning id`,
          values
        )) as { rows: unknown[] }

        if (result.rows.length === 0) {
          report.skippedConcurrent += 1
          await client.query("rollback")
          continue
        }
        await client.query("commit")
        report.rewritten += 1
      } catch (error) {
        await client.query("rollback").catch(() => undefined)
        throw error
      } finally {
        if (client !== db && "release" in client) (client as { release: () => void }).release()
      }
    }

    reports.push(report)
  }

  return reports
}
