/**
 * Gemini client factory (Developer API or Vertex AI). Lives here so the LLM
 * layer does not import `lib/ai/providers.ts` (which imports the pipeline);
 * `providers.ts` re-exports these for existing callers.
 */
import { GoogleGenAI } from "@google/genai"

export type GeminiProviderMode = "gemini-developer-api" | "vertex-ai"

export function getGeminiProviderMode(): GeminiProviderMode {
  return process.env.GOOGLE_GENAI_USE_VERTEXAI === "true" ? "vertex-ai" : "gemini-developer-api"
}

export function isGeminiConfigured() {
  if (getGeminiProviderMode() === "vertex-ai") {
    return Boolean(
      process.env.GOOGLE_CLOUD_PROJECT &&
        process.env.GOOGLE_CLOUD_LOCATION &&
        process.env.GOOGLE_APPLICATION_CREDENTIALS
    )
  }

  return Boolean(process.env.GOOGLE_GEMINI_API_KEY)
}

export function getGeminiHttpOptions() {
  return {
    timeout: Number(process.env.GOOGLE_GEMINI_HTTP_TIMEOUT_MS ?? 900_000),
  }
}

export function createGeminiClient() {
  if (getGeminiProviderMode() === "vertex-ai") {
    return new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION ?? "global",
      httpOptions: getGeminiHttpOptions(),
    })
  }

  return new GoogleGenAI({
    apiKey: process.env.GOOGLE_GEMINI_API_KEY,
    httpOptions: getGeminiHttpOptions(),
  })
}
