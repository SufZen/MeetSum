import { getActiveEmbeddingKey } from "@/lib/ai/embeddings"
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL, parseEmbeddingKey } from "@/lib/ai/embeddings/config"
import { getDatabasePool } from "@/lib/db/client"
import { describeSearchCapabilities, detectSearchCapabilities } from "@/lib/search/capabilities"
import { formatEmbeddingKey } from "@/lib/search/types"
import { ensureVectorSupport, gcStaleEmbeddings } from "@/lib/search/vector-ddl"

/**
 * Installs the optional pgvector part of migration 025 after the fact (M6,
 * docs/parity/m6.md A5): the `vector` extension, `meeting_chunk_embeddings`
 * and the partial HNSW index of the embedding key. Idempotent; a no-op
 * report when 025 already installed it, and a clear reason when pgvector
 * ≥ 0.8 is not available.
 *
 *   --key model:dims   index for another key (default: the active key, else
 *                      gemini-embedding-001:1536)
 *   --gc               delete other keys' vectors for meetings already
 *                      indexed with the active key
 *
 * Prints the capability report. No secrets or meeting content are printed.
 */

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)

  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const keyArg = option("--key")
  const key = keyArg
    ? parseEmbeddingKey(keyArg)
    : (getActiveEmbeddingKey() ?? { model: DEFAULT_EMBEDDING_MODEL, dimensions: DEFAULT_EMBEDDING_DIMENSIONS })

  if (!key) throw new Error(`Invalid --key ${keyArg} (expected <model>:<dims>, model [a-z0-9._-], dims 1..2000)`)

  const db = getDatabasePool()
  const setup = await ensureVectorSupport(db, key)

  console.log(
    setup.enabled
      ? `[search] vector support ready for ${formatEmbeddingKey(key)}`
      : `[search] vector support not installed: ${setup.reason} (search stays lexical)`
  )

  if (process.argv.includes("--gc")) {
    const active = getActiveEmbeddingKey()

    if (!active) console.log("[search] --gc skipped: no active embedding provider")
    else console.log(`[search] removed ${await gcStaleEmbeddings(db, active)} stale vectors (other keys)`)
  }

  const caps = await detectSearchCapabilities(db, getActiveEmbeddingKey())

  console.log(describeSearchCapabilities(caps))
  console.log(JSON.stringify(caps, null, 2))
}

main()
  .catch((error) => {
    console.error("[search] vector setup failed:", error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    if (process.env.DATABASE_URL) await getDatabasePool().end().catch(() => undefined)
  })
