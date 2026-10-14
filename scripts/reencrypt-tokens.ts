/**
 * Token-key rotation (docs/parity/m10.md, R10; runbook:
 * docs/runbooks/integrations.md, "Rotating the token-encryption key").
 *
 *   tsx scripts/reencrypt-tokens.ts            # dry run: counts only
 *   tsx scripts/reencrypt-tokens.ts --apply    # rewrite rows under the current key
 *
 * Needs DATABASE_URL, the new GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY and every old
 * key in GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEYS_PREVIOUS. Prints counts per table;
 * never prints a token, a key or the database URL.
 */
import pg from "pg"

import { reencryptStoredSecrets } from "../lib/auth/reencrypt"
import { currentSecretKeyId } from "../lib/auth/secret-crypto"

const apply = process.argv.includes("--apply")
const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  console.error("DATABASE_URL is required")
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })

try {
  console.log(`${apply ? "APPLY" : "DRY RUN"}: re-encrypting stored secrets under key ${currentSecretKeyId()}`)
  const reports = await reencryptStoredSecrets(pool, { apply })

  for (const report of reports) {
    console.log(
      `${report.table}: rows=${report.rows} current=${report.current} ${apply ? "rewritten" : "would_rewrite"}=${report.rewritten} failed=${report.failed} skipped_concurrent=${report.skippedConcurrent}`
    )
  }

  const failed = reports.reduce((sum, report) => sum + report.failed, 0)

  if (failed > 0) {
    console.error(`${failed} row(s) could not be decrypted with the keyring: add the missing old key to GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEYS_PREVIOUS (rows are left untouched).`)
    process.exitCode = 1
  }
  if (!apply) console.log("Dry run only. Re-run with --apply to write.")
} catch (error) {
  console.error(`reencrypt-tokens failed: ${error instanceof Error ? error.name : "error"}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
