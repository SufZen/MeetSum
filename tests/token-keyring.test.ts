import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { reencryptStoredSecrets } from "@/lib/auth/reencrypt"
import {
  currentSecretKeyId,
  decryptSecret,
  encryptSecret,
  reencryptSecret,
  secretKeyId,
  secretNeedsReencryption,
} from "@/lib/auth/secret-crypto"

/**
 * M10 R10: token-encryption keyring. The current key encrypts; the current
 * key and GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEYS_PREVIOUS decrypt; the re-encrypt
 * script is a dry run unless asked to apply and never clobbers a concurrent
 * refresh (docs/parity/m10.md, D5).
 */

const OLD = "keyring-test-old-key"
const NEW = "keyring-test-new-key"
const AAD = "ws_1:intc_1:access_token"

/** A 4-part value exactly as pre-M10 code wrote it (no key id). */
function legacyV1(source: string, value: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(source).digest(), iv)
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])

  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":")
}

function useKeys(current: string, previous?: string) {
  vi.stubEnv("GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY", current)
  vi.stubEnv("GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEYS_PREVIOUS", previous ?? "")
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("secret-crypto keyring", () => {
  it("writes the current key id as a fifth segment and keeps the v1/v2 prefixes", () => {
    useKeys(NEW)
    const unbound = encryptSecret("refresh")
    const bound = encryptSecret("xoxb", AAD)

    expect(unbound.split(":")).toHaveLength(5)
    expect(unbound.startsWith("v1:")).toBe(true)
    expect(bound.startsWith("v2:")).toBe(true)
    expect(unbound.split(":")[4]).toBe(secretKeyId(NEW))
    expect(currentSecretKeyId()).toMatch(/^k[0-9a-f]{8}$/)
    expect(secretKeyId(NEW)).not.toContain(NEW)
  })

  it("decrypts values from a previous key after rotation, and pre-M10 values without a key id", () => {
    useKeys(OLD)
    const oldUnbound = encryptSecret("refresh")
    const oldBound = encryptSecret("xoxb", AAD)
    const legacy = legacyV1(OLD, "legacy")

    useKeys(NEW, `unrelated-key, ${OLD}`)
    expect(decryptSecret(oldUnbound)).toBe("refresh")
    expect(decryptSecret(oldBound, AAD)).toBe("xoxb")
    expect(decryptSecret(legacy)).toBe("legacy")
    expect(encryptSecret("fresh").split(":")[4]).toBe(secretKeyId(NEW))
  })

  it("fails closed when the old key was dropped from the keyring, or the key id is malformed", () => {
    useKeys(OLD)
    const oldUnbound = encryptSecret("refresh")

    useKeys(NEW)
    expect(() => decryptSecret(oldUnbound)).toThrow("Encrypted secret key is not in the keyring")
    expect(() => decryptSecret(legacyV1(OLD, "x"))).toThrow()
    expect(() => decryptSecret(`${oldUnbound.split(":").slice(0, 4).join(":")}:not-a-kid`)).toThrow("Unsupported encrypted secret format")
  })

  it("rejects a key id swapped to another keyring key (GCM authentication)", () => {
    useKeys(OLD)
    const sealed = encryptSecret("refresh").split(":")

    useKeys(NEW, OLD)
    sealed[4] = secretKeyId(NEW)
    expect(() => decryptSecret(sealed.join(":"))).toThrow()
  })

  it("flags values for re-encryption and re-encrypts under the current key", () => {
    useKeys(OLD)
    const oldBound = encryptSecret("xoxb", AAD)

    useKeys(NEW, OLD)
    expect(secretNeedsReencryption(oldBound)).toBe(true)
    expect(secretNeedsReencryption(legacyV1(OLD, "x"))).toBe(true)

    const rotated = reencryptSecret(oldBound, AAD)

    expect(secretNeedsReencryption(rotated)).toBe(false)
    useKeys(NEW)
    expect(decryptSecret(rotated, AAD)).toBe("xoxb")
  })

  it("never logs key material", () => {
    const code = readFileSync("lib/auth/secret-crypto.ts", "utf8") + readFileSync("lib/auth/reencrypt.ts", "utf8")

    expect(code).not.toMatch(/console\.|logger\.|getLogger/)
  })
})

type PGliteLike = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  exec: (text: string) => Promise<unknown>
  close: () => Promise<void>
}

let db: PGliteLike | undefined

beforeAll(async () => {
  try {
    const { PGlite } = await import("@electric-sql/pglite")

    db = (await PGlite.create()) as unknown as PGliteLike
    await db.exec(`
      create table google_identities (id text primary key, oauth_refresh_token text);
      create table webhook_subscriptions (id text primary key, secret_ciphertext text);
      create table bot_sessions (id text primary key, passcode_enc text);
      create table integration_connections (id text primary key, workspace_id text not null,
        access_token_enc text, refresh_token_enc text, token_generation integer not null default 0);
    `)
  } catch {
    db = undefined
  }
}, 60_000)

afterAll(async () => {
  await db?.close()
})

describe("reencryptStoredSecrets", () => {
  beforeEach(async () => {
    if (!db) return
    await db.exec(
      "delete from google_identities; delete from webhook_subscriptions; delete from bot_sessions; delete from integration_connections;"
    )
    useKeys(OLD)
    await db.query("insert into google_identities values ('gi_1', $1), ('gi_2', null)", [encryptSecret("google-refresh")])
    await db.query("insert into webhook_subscriptions values ('wh_1', $1)", [legacyV1(OLD, "whsec")])
    await db.query("insert into bot_sessions values ('bot_1', 'v1:not:a-valid:value')")
    await db.query("insert into integration_connections values ('intc_1', 'ws_1', $1, $2, 3)", [
      encryptSecret("xoxb", "ws_1:intc_1:access_token"),
      encryptSecret("xoxe", "ws_1:intc_1:refresh_token"),
    ])
  })

  it("is a dry run by default: counts, writes nothing", async (context) => {
    if (!db) return context.skip("PGlite unavailable")
    useKeys(NEW, OLD)
    const before = await db.query("select oauth_refresh_token from google_identities where id = 'gi_1'")
    const report = await reencryptStoredSecrets(db, { apply: false })

    expect(report.map((row) => [row.table, row.rows, row.rewritten, row.failed])).toEqual([
      ["google_identities", 1, 1, 0],
      ["webhook_subscriptions", 1, 1, 0],
      ["bot_sessions", 1, 0, 1],
      ["integration_connections", 1, 1, 0],
    ])
    expect((await db.query("select oauth_refresh_token from google_identities where id = 'gi_1'")).rows).toEqual(before.rows)
    expect(JSON.stringify(report)).not.toMatch(/google-refresh|whsec|xox/)
  })

  it("applies under the current key, keeps the token generation, and is idempotent", async (context) => {
    if (!db) return context.skip("PGlite unavailable")
    useKeys(NEW, OLD)
    await reencryptStoredSecrets(db, { apply: true })

    useKeys(NEW)
    const gi = (await db.query("select oauth_refresh_token as v from google_identities where id = 'gi_1'")).rows[0] as { v: string }
    const wh = (await db.query("select secret_ciphertext as v from webhook_subscriptions")).rows[0] as { v: string }
    const conn = (await db.query("select * from integration_connections")).rows[0] as Record<string, string | number>

    expect(decryptSecret(gi.v)).toBe("google-refresh")
    expect(decryptSecret(wh.v)).toBe("whsec")
    expect(decryptSecret(conn.access_token_enc as string, "ws_1:intc_1:access_token")).toBe("xoxb")
    expect(decryptSecret(conn.refresh_token_enc as string, "ws_1:intc_1:refresh_token")).toBe("xoxe")
    expect(conn.token_generation).toBe(3)

    const again = await reencryptStoredSecrets(db, { apply: true })

    expect(again.find((row) => row.table === "integration_connections")).toMatchObject({ current: 1, rewritten: 0 })
  })

  it("skips a connection whose generation moved under it (CAS) and never bumps the generation", async (context) => {
    if (!db) return context.skip("PGlite unavailable")
    useKeys(NEW, OLD)
    // One PGlite session cannot run two transactions, so model the race as a
    // stale read: the locked select reports generation 2 while the row is at 3
    // (a refresh committed in between). The conditional update must not land.
    const raceDb = {
      query: async (text: string, values?: unknown[]) => {
        const result = await db!.query(text, values)

        if (text.startsWith("select id, access_token_enc")) {
          return { rows: result.rows.map((row) => ({ ...(row as object), token_generation: 2 })) }
        }
        return result
      },
    }
    const before = (await db.query("select access_token_enc from integration_connections")).rows
    const report = await reencryptStoredSecrets(raceDb, { apply: true })
    const conn = (await db.query("select * from integration_connections")).rows[0] as Record<string, string | number>

    expect(report.find((row) => row.table === "integration_connections")).toMatchObject({ skippedConcurrent: 1, rewritten: 0 })
    expect(conn.token_generation).toBe(3)
    expect((await db.query("select access_token_enc from integration_connections")).rows).toEqual(before)
  })
})
