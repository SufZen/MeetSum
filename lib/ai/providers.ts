import { GoogleGenAI, Type } from "@google/genai"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import {
  buildMeetingIntelligence,
  cleanupTranscriptSegments,
  type SmartTask,
} from "@/lib/intelligence"
import type {
  MeetingRecord,
  TranscriptSegment,
} from "@/lib/meetings/repository"
import {
  downloadMeetingObjectToFile,
  getMeetingObjectBytes,
} from "@/lib/storage/object-storage"

const execFileAsync = promisify(execFile)

export type TranscriptionProvider = {
  transcribe: (meeting: MeetingRecord) => Promise<TranscriptSegment[]>
}

export type SummaryProvider = {
  summarize: (meeting: MeetingRecord) => Promise<ReturnType<typeof buildMeetingIntelligence>>
}

function inferSpeaker(participant: string | undefined, index: number) {
  return participant || `Speaker ${index + 1}`
}

export type GeminiProviderMode = "gemini-developer-api" | "vertex-ai"

export function getGeminiProviderMode(): GeminiProviderMode {
  return process.env.GOOGLE_GENAI_USE_VERTEXAI === "true"
    ? "vertex-ai"
    : "gemini-developer-api"
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

function getGeminiHttpOptions() {
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

type GeminiTranscriptSegment = {
  speaker?: string
  startMs?: number
  endMs?: number
  text?: string
  language?: string
  confidence?: number
  uncertainty?: boolean
}

function normalizeGeminiSegments(
  segments: GeminiTranscriptSegment[],
  meeting: MeetingRecord
): TranscriptSegment[] {
  const normalized = segments
    .filter((segment) => segment.text?.trim())
    .map((segment, index) => ({
      id: `seg_${crypto.randomUUID()}`,
      speaker: segment.speaker?.trim() || inferSpeaker(meeting.participants[index], index),
      startMs: Math.max(0, Number(segment.startMs ?? index * 5000)),
      endMs: Math.max(
        Number(segment.startMs ?? index * 5000) + 1000,
        Number(segment.endMs ?? (index + 1) * 5000)
      ),
      text: segment.uncertainty
        ? `[uncertain] ${segment.text?.trim()}`
        : segment.text?.trim() ?? "",
      confidence: Math.min(1, Math.max(0, Number(segment.confidence ?? 0.7))),
      language: segment.language ?? meeting.language,
    }))

  return cleanupTranscriptSegments(normalized)
}

function getAudioPrompt(meeting: MeetingRecord, compactTimeline = false) {
  return [
    compactTimeline
      ? "Create compact timestamped transcript notes for this long meeting audio/video as structured JSON."
      : "Transcribe this meeting audio/video as structured JSON.",
    "Return ONLY JSON with a top-level `segments` array.",
    "Each segment must include: speaker, startMs, endMs, text, language, confidence, uncertainty.",
    compactTimeline
      ? "For long recordings, do not create a verbatim transcript. Return 30-80 concise timeline segments that preserve decisions, tasks, blockers, names, numbers, and important quotes."
      : "Prefer faithful transcript text, split into timestamped speaker turns.",
    "Use speaker labels like Speaker 1, Speaker 2 when names are not clear.",
    "Support Hebrew, English, Portuguese, Spanish, Italian, and mixed-language meetings.",
    "For Hebrew, preserve names, numbers, dates, currencies, percentages, and mixed English technical terms such as VSCode, Supabase, MCP, RealizeOS, Gemini, Gemma.",
    "Do not invent inaudible details. Mark uncertainty=true when unclear.",
    `Meeting title: ${meeting.title}`,
    `Known participants: ${meeting.participants.join(", ") || "unknown"}`,
  ].join("\n")
}

function stripJsonFence(value: string) {
  return value
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim()
}

function parseGeminiTranscriptSegments(raw: string): GeminiTranscriptSegment[] {
  const text = stripJsonFence(raw)

  try {
    const parsed = JSON.parse(text) as { segments?: GeminiTranscriptSegment[] }
    return parsed.segments ?? []
  } catch {
    const segments: GeminiTranscriptSegment[] = []
    const objectPattern =
      /\{[^{}]*"text"\s*:\s*"(?:(?:\\.)|[^"\\])*"[^{}]*\}/g

    for (const match of text.matchAll(objectPattern)) {
      try {
        const parsed = JSON.parse(match[0]) as GeminiTranscriptSegment
        if (parsed.text?.trim()) segments.push(parsed)
      } catch {
        // Keep scanning; Gemini can truncate the tail of an otherwise useful JSON payload.
      }
    }

    if (segments.length) return segments

    const textPattern = /"text"\s*:\s*"((?:(?:\\.)|[^"\\])*)"/g

    for (const match of text.matchAll(textPattern)) {
      try {
        const parsedText = JSON.parse(`"${match[1]}"`) as string
        if (parsedText.trim()) segments.push({ text: parsedText })
      } catch {
        // Ignore a malformed fragment and keep any other recoverable segments.
      }
    }

    return segments
  }
}

function safeTempFilename(filename: string | undefined, fallback: string) {
  return (filename ?? fallback).replace(/[^\w. -]+/g, "_")
}

async function extractAudioForGemini(inputPath: string, outputPath: string) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      outputPath,
    ],
    {
      maxBuffer: 1024 * 1024 * 8,
      timeout: Number(process.env.MEETSUM_FFMPEG_TIMEOUT_MS ?? 900_000),
    }
  )
}

async function compressMediaForInlineGemini(inputPath: string, outputPath: string) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      process.env.MEETSUM_GEMINI_COMPRESSED_AUDIO_BITRATE ?? "32k",
      outputPath,
    ],
    {
      maxBuffer: 1024 * 1024 * 8,
      timeout: Number(process.env.MEETSUM_FFMPEG_TIMEOUT_MS ?? 900_000),
    }
  )
}

function shouldFallbackToCompressedInline(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  return (
    message.includes('"code":404') ||
    message.includes("fetchUploadUrl") ||
    message.toLowerCase().includes("file upload")
  )
}

async function waitForGeminiFile(
  ai: GoogleGenAI,
  name: string | undefined
) {
  if (!name) return

  const deadline = Date.now() + Number(process.env.GOOGLE_GEMINI_FILE_WAIT_MS ?? 300_000)

  while (Date.now() < deadline) {
    const file = await ai.files.get({
      name,
      config: { httpOptions: getGeminiHttpOptions() },
    })

    if (file.state === "ACTIVE") return
    if (file.state === "FAILED") {
      throw new Error(`Gemini file processing failed for ${name}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 3000))
  }

  throw new Error(`Timed out waiting for Gemini file processing: ${name}`)
}

export class HeuristicFallbackProvider
  implements TranscriptionProvider, SummaryProvider
{
  async transcribe(meeting: MeetingRecord): Promise<TranscriptSegment[]> {
    if (meeting.transcript?.length) {
      return cleanupTranscriptSegments(meeting.transcript)
    }

    return [
      {
        id: `seg_${crypto.randomUUID()}`,
        speaker: inferSpeaker(meeting.participants[0], 0),
        startMs: 0,
        endMs: 5000,
        text: `Uploaded media for ${meeting.title}. Add Gemini credentials or a transcript source to generate a full transcript.`,
        confidence: 0.25,
        language: meeting.language,
      },
    ]
  }

  async summarize(meeting: MeetingRecord) {
    return buildMeetingIntelligence(meeting)
  }
}

export class GeminiSummaryProvider implements SummaryProvider {
  private readonly fallback = new HeuristicFallbackProvider()

  async summarize(meeting: MeetingRecord) {
    if (!isGeminiConfigured() || !meeting.transcript?.length) {
      return this.fallback.summarize(meeting)
    }

    const ai = createGeminiClient()
    const transcript = meeting.transcript
      .map(
        (segment) =>
          `[${Math.floor(segment.startMs / 1000)}s] ${segment.speaker}: ${segment.text}`
      )
      .join("\n")
    const response = await ai.models.generateContent({
      model: process.env.GOOGLE_GEMINI_SUMMARY_MODEL ?? "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                "Create structured meeting intelligence as JSON.",
                "Support Hebrew, English, Portuguese, Spanish, Italian, and mixed-language meetings.",
                "Do not invent details; mark uncertainty in the text when needed.",
                "Action items must be real tasks only: commitments, assignments, next steps, decisions requiring follow-up, or explicit requests. Do not copy ordinary transcript fragments as tasks.",
                "For every action item, include title, owner if known, dueDate if stated or strongly implied, priority, confidence, sourceQuote, sourceStartMs, and kind explicit/inferred.",
                "Decisions should be concise business decisions and should not include generic discussion.",
                `Meeting: ${meeting.title}`,
                transcript,
              ].join("\n\n"),
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            overview: { type: Type.STRING },
            decisions: { type: Type.ARRAY, items: { type: Type.STRING } },
            actionItems: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  owner: { type: Type.STRING },
                  dueDate: { type: Type.STRING },
                  priority: { type: Type.STRING },
                  confidence: { type: Type.NUMBER },
                  sourceQuote: { type: Type.STRING },
                  sourceStartMs: { type: Type.NUMBER },
                  kind: { type: Type.STRING },
                },
                required: ["title"],
              },
            },
            risks: { type: Type.ARRAY, items: { type: Type.STRING } },
            openQuestions: { type: Type.ARRAY, items: { type: Type.STRING } },
            commitments: { type: Type.ARRAY, items: { type: Type.STRING } },
            followUpDraft: { type: Type.STRING },
            tags: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ["overview"],
        },
      },
    })

    try {
      const parsed = JSON.parse(response.text ?? "{}") as Partial<
        ReturnType<typeof buildMeetingIntelligence>
      >
      const fallback = buildMeetingIntelligence(meeting)
      const parsedActionItems: SmartTask[] = Array.isArray(parsed.actionItems)
        ? parsed.actionItems
            .filter((item) => item?.title && String(item.title).trim().length > 0)
            .slice(0, 20)
            .map((item, index) => {
              const priority: SmartTask["priority"] =
                item.priority === "low" ||
                item.priority === "high" ||
                item.priority === "urgent"
                  ? item.priority
                  : "normal"
              const kind: SmartTask["kind"] =
                item.kind === "inferred" ? "inferred" : "explicit"

              return {
                id: item.id ?? `task_${crypto.randomUUID()}_${index}`,
                title: String(item.title).trim(),
                owner: item.owner ? String(item.owner) : undefined,
                status: item.status === "done" ? "done" : "open",
                dueDate: item.dueDate ? String(item.dueDate) : undefined,
                priority,
                confidence:
                typeof item.confidence === "number"
                  ? Math.min(1, Math.max(0, item.confidence))
                  : 0.75,
                sourceQuote: item.sourceQuote
                  ? String(item.sourceQuote)
                  : String(item.title),
                sourceStartMs:
                  typeof item.sourceStartMs === "number" ? item.sourceStartMs : 0,
                kind,
              }
            })
        : fallback.actionItems

      return {
        ...fallback,
        overview: parsed.overview ?? fallback.overview,
        decisions: parsed.decisions ?? fallback.decisions,
        actionItems: parsedActionItems,
        risks: parsed.risks ?? fallback.risks,
        openQuestions: parsed.openQuestions ?? fallback.openQuestions,
        commitments: parsed.commitments ?? fallback.commitments,
        followUpDraft: parsed.followUpDraft ?? fallback.followUpDraft,
        tags: parsed.tags ?? fallback.tags,
      }
    } catch {
      return this.fallback.summarize(meeting)
    }
  }
}

export class GeminiAudioTranscriptionProvider implements TranscriptionProvider {
  private readonly fallback = new HeuristicFallbackProvider()

  async transcribe(meeting: MeetingRecord): Promise<TranscriptSegment[]> {
    const asset = meeting.mediaAssets?.[0]

    if (!isGeminiConfigured() || !asset?.storageKey) {
      return this.fallback.transcribe(meeting)
    }

    let tempDir: string | undefined

    try {
      const ai = createGeminiClient()
      const sizeBytes = Number(asset.sizeBytes ?? 0)
      const inlineLimit = Number(
        process.env.GOOGLE_GEMINI_INLINE_AUDIO_LIMIT_BYTES ?? 18_000_000
      )
      const useInline =
        sizeBytes > 0 ? sizeBytes <= inlineLimit : true
      const prompt = getAudioPrompt(meeting, !useInline)

      if (!useInline && getGeminiProviderMode() === "vertex-ai") {
        throw new Error(
          "Large media on Vertex AI requires a GCS-backed media handoff"
        )
      }

      let mediaPart:
        | { inlineData: { mimeType: string; data: string } }
        | { fileData: { mimeType: string; fileUri: string } }

      if (useInline) {
        const bytes = await getMeetingObjectBytes(asset.storageKey)
        mediaPart = {
          inlineData: {
            mimeType: asset.contentType,
            data: bytes.toString("base64"),
          },
        }
      } else {
        tempDir = await mkdtemp(path.join(tmpdir(), "meetsum-gemini-"))
        const inputPath = path.join(
          tempDir,
          safeTempFilename(asset.filename, `${meeting.id}.media`)
        )
        await downloadMeetingObjectToFile(asset.storageKey, inputPath)

        let uploadPath = inputPath
        let uploadMimeType = asset.contentType

        if (asset.contentType.startsWith("video/")) {
          const audioPath = path.join(tempDir, `${meeting.id}.m4a`)
          await extractAudioForGemini(inputPath, audioPath)
          uploadPath = audioPath
          uploadMimeType = "audio/mp4"
        }

        const compressedInlinePath = path.join(tempDir, `${meeting.id}.inline.m4a`)

        try {
          const uploaded = await ai.files.upload({
            file: uploadPath,
            config: {
              mimeType: uploadMimeType,
              displayName: asset.filename ?? `${meeting.id}-media`,
              httpOptions: getGeminiHttpOptions(),
            },
          })
          await waitForGeminiFile(ai, uploaded.name)
          if (!uploaded.uri) {
            throw new Error("Gemini file upload did not return a file URI")
          }
          mediaPart = {
            fileData: {
              mimeType: uploadMimeType,
              fileUri: uploaded.uri,
            },
          }
        } catch (error) {
          if (!shouldFallbackToCompressedInline(error)) {
            throw error
          }

          await compressMediaForInlineGemini(uploadPath, compressedInlinePath)
          const compressedSize = (await stat(compressedInlinePath)).size

          if (compressedSize > inlineLimit) {
            throw error
          }

          const bytes = await readFile(compressedInlinePath)

          mediaPart = {
            inlineData: {
              mimeType: "audio/mp4",
              data: bytes.toString("base64"),
            },
          }
        }
      }

      const response = await ai.models.generateContent({
        model: process.env.GOOGLE_GEMINI_AUDIO_MODEL ?? "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }, mediaPart],
          },
        ],
        config: {
          httpOptions: getGeminiHttpOptions(),
          maxOutputTokens: Number(
            process.env.GOOGLE_GEMINI_TRANSCRIPT_MAX_OUTPUT_TOKENS ?? 65_536
          ),
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              segments: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    speaker: { type: Type.STRING },
                    startMs: { type: Type.NUMBER },
                    endMs: { type: Type.NUMBER },
                    text: { type: Type.STRING },
                    language: { type: Type.STRING },
                    confidence: { type: Type.NUMBER },
                    uncertainty: { type: Type.BOOLEAN },
                  },
                  required: ["text"],
                },
              },
            },
            required: ["segments"],
          },
        },
      })

      const segments = normalizeGeminiSegments(
        parseGeminiTranscriptSegments(response.text ?? "{}"),
        meeting
      )

      return segments.length ? segments : this.fallback.transcribe(meeting)
    } catch (error) {
      console.error("Gemini audio transcription failed", error)
      throw error
    } finally {
      if (typeof tempDir === "string") {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
}

export function createTranscriptionProvider(): TranscriptionProvider {
  return isGeminiConfigured()
    ? new GeminiAudioTranscriptionProvider()
    : new HeuristicFallbackProvider()
}

export function createSummaryProvider(): SummaryProvider {
  return isGeminiConfigured()
    ? new GeminiSummaryProvider()
    : new HeuristicFallbackProvider()
}
