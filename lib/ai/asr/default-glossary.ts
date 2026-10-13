import type { AsrGlossary } from "./types"

/**
 * Built-in glossary merged under every workspace glossary. Hebrew
 * transliterations of technical terms the ASR models tend to mangle; the
 * same list lib/intelligence's transcript cleanup rewrites today. Pure data
 * (no server imports) so client code can show the defaults.
 */
export const DEFAULT_ASR_GLOSSARY: AsrGlossary = {
  version: 1,
  terms: [
    { term: "Supabase", aliases: ["סופרבייס", "סופבייס", "סופה בייס"], hotword: true },
    { term: "Gemini", aliases: ["ג'מיני", "ג׳מיני", "גמיני"], hotword: true },
    { term: "Gemma", aliases: ["גמה"], hotword: true },
    { term: "Claude Code", aliases: ["קלוד קוד"], hotword: true },
    { term: "RealizeOS", aliases: ["רילייז אוס", "רילייזאוס"], hotword: true },
    { term: "VSCode", aliases: ["ויסקוד"], hotword: true },
    { term: "MCP", aliases: ["אם סי פי"], hotword: true },
  ],
}
