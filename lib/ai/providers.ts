import { GoogleGenAI, Type } from "@google/genai"

import { buildMeetingIntelligence, cleanupTranscriptSegments } from "@/lib/intelligence"
import type {
  MeetingRecord,
  TranscriptSegment,
} from "@/lib/meetings/repository"

export type TranscriptionProvider = {
  transcribe: (meeting: MeetingRecord) => Promise<TranscriptSegment[]>
}

export type SummaryProvider = {
  summarize: (meeting: MeetingRecord) => Promise<ReturnType<typeof buildMeetingIntelligence>>
}

function inferSpeaker(participant: string | undefined, index: number) {
  return participant || `Speaker ${index + 1}`
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
    return this.fallback.transcribe(meeting)
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
