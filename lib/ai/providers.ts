import { GoogleGenAI, Type } from "@google/genai"

import { buildMeetingIntelligence, cleanupTranscriptSegments } from "@/lib/intelligence"
import type {
  MeetingRecord,
  TranscriptSegment,
} from "@/lib/meetings/repository"
import { getMeetingObjectBytes } from "@/lib/storage/object-storage"

export type TranscriptionProvider = {
  transcribe: (meeting: MeetingRecord) => Promise<TranscriptSegment[]>
}

export type SummaryProvider = {
  summarize: (meeting: MeetingRecord) => Promise<ReturnType<typeof buildMeetingIntelligence>>
}

function inferSpeaker(participant: string | undefined, index: number) {
  return participant || `Speaker ${index + 1}`
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

function getAudioPrompt(meeting: MeetingRecord) {
  return [
    "Transcribe this meeting audio/video as structured JSON.",
    "Return ONLY JSON with a top-level `segments` array.",
    "Each segment must include: speaker, startMs, endMs, text, language, confidence, uncertainty.",
    "Use speaker labels like Speaker 1, Speaker 2 when names are not clear.",
    "Support Hebrew, English, Portuguese, Spanish, Italian, and mixed-language meetings.",
    "For Hebrew, preserve names, numbers, dates, currencies, percentages, and mixed English technical terms such as VSCode, Supabase, MCP, RealizeOS, Gemini, Gemma.",
    "Do not invent inaudible details. Mark uncertainty=true when unclear.",
    `Meeting title: ${meeting.title}`,
    `Known participants: ${meeting.participants.join(", ") || "unknown"}`,
  ].join("\n")
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
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY

    if (!apiKey || !meeting.transcript?.length) {
      return this.fallback.summarize(meeting)
    }

    const ai = new GoogleGenAI({ apiKey })
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
            risks: { type: Type.ARRAY, items: { type: Type.STRING } },
            openQuestions: { type: Type.ARRAY, items: { type: Type.STRING } },
            commitments: { type: Type.ARRAY, items: { type: Type.STRING } },
            followUpDraft: { type: Type.STRING },
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

      return {
        ...fallback,
        overview: parsed.overview ?? fallback.overview,
        decisions: parsed.decisions ?? fallback.decisions,
        risks: parsed.risks ?? fallback.risks,
        openQuestions: parsed.openQuestions ?? fallback.openQuestions,
        commitments: parsed.commitments ?? fallback.commitments,
        followUpDraft: parsed.followUpDraft ?? fallback.followUpDraft,
      }
    } catch {
      return this.fallback.summarize(meeting)
    }
  }
}

export class GeminiAudioTranscriptionProvider implements TranscriptionProvider {
  private readonly fallback = new HeuristicFallbackProvider()

  async transcribe(meeting: MeetingRecord): Promise<TranscriptSegment[]> {
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY
    const asset = meeting.mediaAssets?.[0]

    if (!apiKey || !asset?.storageKey) {
      return this.fallback.transcribe(meeting)
    }

    try {
      const ai = new GoogleGenAI({ apiKey })
      const bytes = await getMeetingObjectBytes(asset.storageKey)
      const prompt = getAudioPrompt(meeting)
      const mediaPart =
        bytes.byteLength <=
        Number(process.env.GOOGLE_GEMINI_INLINE_AUDIO_LIMIT_BYTES ?? 18_000_000)
          ? {
              inlineData: {
                mimeType: asset.contentType,
                data: bytes.toString("base64"),
              },
            }
          : {
              fileData: {
                mimeType: asset.contentType,
                fileUri: (
                  await ai.files.upload({
                    file: new Blob(
                      [
                        bytes.buffer.slice(
                          bytes.byteOffset,
                          bytes.byteOffset + bytes.byteLength
                        ) as ArrayBuffer,
                      ],
                      { type: asset.contentType }
                    ),
                    config: {
                      mimeType: asset.contentType,
                      displayName: asset.filename ?? `${meeting.id}-media`,
                    },
                  })
                ).uri,
              },
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

      const parsed = JSON.parse(response.text ?? "{}") as {
        segments?: GeminiTranscriptSegment[]
      }
      const segments = normalizeGeminiSegments(parsed.segments ?? [], meeting)

      return segments.length ? segments : this.fallback.transcribe(meeting)
    } catch {
      return this.fallback.transcribe(meeting)
    }
  }
}

export function createTranscriptionProvider(): TranscriptionProvider {
  return process.env.GOOGLE_GEMINI_API_KEY
    ? new GeminiAudioTranscriptionProvider()
    : new HeuristicFallbackProvider()
}

export function createSummaryProvider(): SummaryProvider {
  return process.env.GOOGLE_GEMINI_API_KEY
    ? new GeminiSummaryProvider()
    : new HeuristicFallbackProvider()
}
