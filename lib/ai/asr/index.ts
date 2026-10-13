import type {
  AsrGlossary,
  AsrHealth,
  AsrProvider,
  AsrProviderId,
  AsrRequest,
  AsrRouterResult,
} from "./types"

export * from "./types"

/**
 * Built-in glossary merged under every workspace glossary. Hebrew
 * transliterations of technical terms the ASR models tend to mangle; the
 * same list lib/intelligence's transcript cleanup rewrites today.
 */
export const DEFAULT_ASR_GLOSSARY: AsrGlossary = {
  version: 1,
  terms: [
    { term: "Supabase", aliases: ["סופרבייס"], hotword: true },
    { term: "Gemini", aliases: ["ג'מיני", "ג׳מיני", "גמיני"], hotword: true },
    { term: "Gemma", aliases: ["גמה"], hotword: true },
    { term: "Claude Code", aliases: ["קלוד קוד"], hotword: true },
    { term: "RealizeOS", aliases: ["רילייז אוס", "רילייזאוס"], hotword: true },
    { term: "VSCode", aliases: ["ויסקוד"], hotword: true },
    { term: "MCP", aliases: ["אם סי פי"], hotword: true },
  ],
}

export type AsrRouterOptions = {
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  providers?: AsrProvider[]
}

export type AsrRouterStatus = {
  /** Provider order used for Hebrew / mixed meetings. */
  chain: AsrProviderId[]
  /** Provider order used for other languages. */
  nonHebrewChain: AsrProviderId[]
  providers: AsrHealth[]
}

/**
 * Transcribes through the configured provider chain with fallback and
 * circuit breaking. Stub until the M3 ASR engine lands.
 */
export async function transcribeWithRouter(
  req: AsrRequest,
  opts?: AsrRouterOptions
): Promise<AsrRouterResult> {
  void req
  void opts
  throw new Error("transcribeWithRouter: not implemented (M3)")
}

/** Chain + per-provider health/breaker state. Stub: empty chain. */
export async function getAsrRouterStatus(
  opts?: AsrRouterOptions
): Promise<AsrRouterStatus> {
  void opts
  return { chain: [], nonHebrewChain: [], providers: [] }
}
