import { formatDate } from "@/lib/i18n/format"
import { firstStrongDirection, isRtlLanguage, LRI, PDI } from "@/lib/integrations/bidi"
import { getExportsMessages, type ExportsMessages } from "@/lib/i18n/m8/exports"
import type { MeetingRecord } from "@/lib/meetings/repository"
import { getTaskTimeZone } from "@/lib/tasks/time-zone"

/**
 * Meeting exports: Markdown, PDF and DOCX (M8 C3; owner since M9: Package B).
 *
 * - Headings and labels are localized (`he`/`en`, lib/i18n/m8/exports.ts);
 *   dates go through lib/i18n/format.ts in `getTaskTimeZone()`.
 * - DOCX writes real RTL: a Hebrew paragraph gets `bidirectional` (`<w:bidi/>`)
 *   and `alignment: start`; every Hebrew run gets `rightToLeft` (`<w:rtl/>`),
 *   a complex-script font and `he-IL`. Latin words inside Hebrew text become
 *   their own LTR runs (mixed he/en). Timecodes and emails are separate LTR
 *   runs isolated with U+2066…U+2069. Transcript direction follows each
 *   segment's language.
 * - The PDF is Hebrew-capable since M9: pdfkit + bidi-js with embedded IBM
 *   Plex fonts (lib/pdf/meeting-pdf.ts, re-exported here).
 */

export { renderMeetingPdf, renderMeetingPdfDetailed, type MeetingPdfOptions } from "@/lib/pdf/meeting-pdf"

export type ExportLocale = "he" | "en"

export type MeetingExportOptions = {
  /** Headings/labels language. Defaults to `en`; routes pass `exportLocaleFor`. */
  locale?: ExportLocale
  env?: NodeJS.ProcessEnv
}

/** An explicit `he`/`en` wins; otherwise Hebrew for RTL meetings, else English. */
export function exportLocaleFor(
  meeting: Pick<MeetingRecord, "language">,
  requested: string | null | undefined
): ExportLocale {
  if (requested === "he" || requested === "en") return requested

  return isRtlLanguage(meeting.language) ? "he" : "en"
}

/** Placeholders and metadata labels that have no shared i18n key. */
const LOCAL_STRINGS: Record<
  ExportLocale,
  {
    noSummary: string
    noDecisions: string
    noActionItems: string
    noTranscript: string
    noParticipants: string
    processedBy: (date: string) => string
  }
> = {
  en: {
    noSummary: "No summary is available yet.",
    noDecisions: "No decisions extracted yet.",
    noActionItems: "No action items extracted yet.",
    noTranscript: "No transcript is available yet.",
    noParticipants: "None recorded",
    processedBy: (date) => `Processed by MeetSum on ${date}`,
  },
  he: {
    noSummary: "עדיין אין סיכום.",
    noDecisions: "עדיין לא חולצו החלטות.",
    noActionItems: "עדיין לא חולצו משימות.",
    noTranscript: "עדיין אין תמליל.",
    noParticipants: "לא נרשמו משתתפים",
    processedBy: (date) => `עובד ב-MeetSum בתאריך ${date}`,
  },
}

function formatMs(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0")
  const seconds = (totalSeconds % 60).toString().padStart(2, "0")

  return `${minutes}:${seconds}`
}

function formatMeetingDate(startedAt: string, locale: ExportLocale, env: NodeJS.ProcessEnv): string {
  return formatDate(startedAt, { locale, timeZone: getTaskTimeZone(env) }, "dateTime") || startedAt
}

function participantNames(meeting: MeetingRecord): string[] {
  return meeting.participantDetails?.length
    ? meeting.participantDetails.map((participant) => participant.name)
    : meeting.participants
}

const taskLabels: Record<string, string> = {
  "audio.transcribe": "Transcription",
  "transcript.clean": "Transcript cleanup",
  "summary.generate": "Summary generation",
  "summary.persist": "Summary persistence",
  "tasks.extract": "Task extraction",
  "meeting.index": "Memory indexing",
  "quality.review": "Quality review",
}

function renderProviderMetadata(meeting: MeetingRecord): string[] {
  const runs = meeting.aiRuns?.filter((r) => r.status === "completed") ?? []

  if (!runs.length) return []

  const lines = [
    "## Processing Metadata",
    "",
    "| Stage | Provider | Model | Latency | Confidence |",
    "|-------|----------|-------|---------|------------|",
  ]

  for (const run of runs) {
    const stage = taskLabels[run.task] ?? run.task
    const provider = run.provider
    const model = run.model ?? "—"
    const latency = run.latencyMs ? `${(run.latencyMs / 1000).toFixed(1)}s` : "—"
    const confidence = run.confidence != null ? `${Math.round(run.confidence * 100)}%` : "—"

    lines.push(`| ${stage} | ${provider} | ${model} | ${latency} | ${confidence} |`)
  }

  lines.push("")
  lines.push(`> Processed by MeetSum on ${new Date().toISOString().split("T")[0]}`)
  lines.push("")

  return lines
}

export function renderMeetingMarkdown(meeting: MeetingRecord, options: MeetingExportOptions = {}): string {
  const locale = options.locale ?? "en"
  const env = options.env ?? process.env
  const t = getExportsMessages(locale)
  const local = LOCAL_STRINGS[locale]
  const metadata =
    locale === "en"
      ? [
          `- ${t.exportLabelDate}: ${formatMeetingDate(meeting.startedAt, locale, env)}`,
          `- Source: ${meeting.source}`,
          `- Language: ${meeting.language}`,
          `- Status: ${meeting.status}`,
        ]
      : [`- ${t.exportLabelDate}: ${formatMeetingDate(meeting.startedAt, locale, env)}`]
  const due = (date: string) => (locale === "he" ? ` - ${t.exportLabelDue} ${isolate(date)}` : ` - due ${date}`)
  const lines = [
    `# ${meeting.title}`,
    "",
    ...metadata,
    `- ${t.exportHeadingParticipants}: ${participantNames(meeting).join(", ") || local.noParticipants}`,
    "",
    `## ${t.exportHeadingOverview}`,
    meeting.summary?.overview || local.noSummary,
    "",
    `## ${t.exportHeadingDecisions}`,
    ...(meeting.summary?.decisions.length
      ? meeting.summary.decisions.map((decision) => `- ${decision}`)
      : [`- ${local.noDecisions}`]),
    "",
    `## ${t.exportHeadingActionItems}`,
    ...(meeting.summary?.actionItems.length
      ? meeting.summary.actionItems.map(
          (item) =>
            `- [${item.status === "done" ? "x" : " "}] ${item.title}${
              item.owner ? ` (${item.owner})` : ""
            }${item.dueDate ? due(item.dueDate) : ""}`
        )
      : [`- ${local.noActionItems}`]),
    "",
    `## ${t.exportHeadingTranscript}`,
    ...(() => {
      const transcribeRun = meeting.aiRuns?.find((r) => r.task === "audio.transcribe")
      if (transcribeRun) {
        let metaLine = `> Transcription provided by **${transcribeRun.provider}**`
        if (transcribeRun.model) {
          metaLine += ` (model: ${transcribeRun.model})`
        }
        if (transcribeRun.metadata?.fallbackUsed) {
          metaLine += ` — Fallback from ${transcribeRun.metadata.attemptedProvider}. Reason: ${transcribeRun.metadata.fallbackReason || "Unknown error"}`
        }
        return [metaLine, ""]
      }
      return []
    })(),
    ...(meeting.transcript?.length
      ? meeting.transcript.map((segment) =>
          locale === "he"
            ? `- ${isolate(formatMs(segment.startMs))} ${segment.speaker}: ${segment.text}`
            : `- ${formatMs(segment.startMs)} ${segment.speaker}: ${segment.text}`
        )
      : [local.noTranscript]),
    "",
    ...renderProviderMetadata(meeting),
  ]

  return lines.join("\n")
}

/** LTR isolate for a timecode, date or email inside RTL text. */
function isolate(token: string): string {
  return `${LRI}${token}${PDI}`
}

// ---------------------------------------------------------------------------
// DOCX

/** A piece of text with one direction (neutrals join the run they follow). */
export type DirectionalPiece = { text: string; rtl: boolean }

/**
 * Splits text into direction runs: Hebrew/Arabic letters → RTL, other
 * letters → LTR; spaces, digits and punctuation stay with the current run
 * (leading neutrals take `baseRtl`). Joining the pieces gives the text back.
 */
export function directionalPieces(text: string, baseRtl: boolean): DirectionalPiece[] {
  const pieces: DirectionalPiece[] = []
  let current: DirectionalPiece | undefined

  for (const char of text) {
    const direction = firstStrongDirection(char)
    const rtl = direction === "neutral" ? (current?.rtl ?? baseRtl) : direction === "rtl"

    if (current && current.rtl === rtl) {
      current.text += char
    } else {
      current = { text: char, rtl }
      pieces.push(current)
    }
  }

  return pieces
}

type RunStyle = {
  bold?: boolean
  italics?: boolean
  strike?: boolean
  color?: string
  /** Half-points. */
  size?: number
}

const BODY_SIZE = 22
const RTL_FONT = { ascii: "Arial", cs: "Arial", hAnsi: "Arial" }

export async function renderMeetingDocx(
  meeting: MeetingRecord,
  options: MeetingExportOptions = {}
): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = await import("docx")
  type ParagraphInstance = InstanceType<typeof Paragraph>
  type TextRunInstance = InstanceType<typeof TextRun>
  type HeadingValue = (typeof HeadingLevel)[keyof typeof HeadingLevel]

  const locale = options.locale ?? "en"
  const env = options.env ?? process.env
  const t: ExportsMessages = getExportsMessages(locale)
  const local = LOCAL_STRINGS[locale]
  const meetingRtl = isRtlLanguage(meeting.language)
  const children: ParagraphInstance[] = []

  function textRuns(text: string, style: RunStyle = {}): TextRunInstance[] {
    const size = style.size ?? BODY_SIZE

    return directionalPieces(text, meetingRtl).map((piece) =>
      piece.rtl
        ? new TextRun({
            text: piece.text,
            ...style,
            size,
            rightToLeft: true,
            font: RTL_FONT,
            sizeComplexScript: size,
            language: { bidirectional: "he-IL" },
          })
        : new TextRun({ text: piece.text, ...style, size })
    )
  }

  /** A timecode, date or email: one isolated LTR run, never `rtl`. */
  function ltrRun(token: string, style: RunStyle = {}): TextRunInstance {
    return new TextRun({ text: isolate(token), ...style, size: style.size ?? BODY_SIZE })
  }

  function paragraph(
    runs: TextRunInstance[],
    rtl: boolean,
    extra: { heading?: HeadingValue; bullet?: boolean; after?: number } = {}
  ): ParagraphInstance {
    return new Paragraph({
      children: runs,
      ...(extra.heading ? { heading: extra.heading } : {}),
      ...(extra.bullet ? { bullet: { level: 0 } } : {}),
      ...(extra.after !== undefined ? { spacing: { after: extra.after } } : {}),
      ...(rtl ? { bidirectional: true, alignment: AlignmentType.START } : {}),
    })
  }

  const heading = (text: string, level: HeadingValue) =>
    paragraph(textRuns(text, { size: level === HeadingLevel.HEADING_1 ? 32 : 26, bold: true }), meetingRtl, {
      heading: level,
    })

  // Title
  children.push(heading(meeting.title, HeadingLevel.HEADING_1))

  // Metadata
  children.push(
    paragraph(
      [
        ...textRuns(`${t.exportLabelDate}: `),
        ltrRun(formatMeetingDate(meeting.startedAt, locale, env)),
      ],
      meetingRtl,
      { after: 80 }
    )
  )
  if (locale === "en") {
    for (const line of [`Source: ${meeting.source}`, `Language: ${meeting.language}`, `Status: ${meeting.status}`]) {
      children.push(paragraph(textRuns(line), meetingRtl, { after: 80 }))
    }
  }

  const participantRuns: TextRunInstance[] = [...textRuns(`${t.exportHeadingParticipants}: `)]
  const details = meeting.participantDetails ?? []

  if (details.length) {
    details.forEach((participant, index) => {
      if (index > 0) participantRuns.push(...textRuns(", "))
      participantRuns.push(...textRuns(participant.name))
      if (participant.email) {
        participantRuns.push(...textRuns(" ("), ltrRun(participant.email), ...textRuns(")"))
      }
    })
  } else {
    participantRuns.push(...textRuns(meeting.participants.join(", ") || local.noParticipants))
  }
  children.push(paragraph(participantRuns, meetingRtl, { after: 80 }))
  children.push(new Paragraph({ text: "" }))

  // Overview
  children.push(heading(t.exportHeadingOverview, HeadingLevel.HEADING_2))
  for (const block of (meeting.summary?.overview || local.noSummary).split(/\n{2,}/)) {
    children.push(paragraph(textRuns(block.trim()), meetingRtl, { after: 200 }))
  }

  // Decisions
  children.push(heading(t.exportHeadingDecisions, HeadingLevel.HEADING_2))
  if (meeting.summary?.decisions.length) {
    for (const decision of meeting.summary.decisions) {
      children.push(paragraph(textRuns(decision), meetingRtl, { bullet: true, after: 80 }))
    }
  } else {
    children.push(paragraph(textRuns(local.noDecisions), meetingRtl, { after: 200 }))
  }

  // Action items
  children.push(heading(t.exportHeadingActionItems, HeadingLevel.HEADING_2))
  if (meeting.summary?.actionItems.length) {
    for (const item of meeting.summary.actionItems) {
      const done = item.status === "done"
      const runs = [
        ...textRuns(`${done ? "☑" : "☐"} `),
        ...textRuns(item.title, { bold: !done, strike: done }),
      ]

      if (item.owner) runs.push(...textRuns(` (${item.owner})`, { italics: true }))
      if (item.dueDate) runs.push(...textRuns(` — ${t.exportLabelDue} `, { italics: true }), ltrRun(item.dueDate, { italics: true }))
      children.push(paragraph(runs, meetingRtl, { after: 80 }))
    }
  } else {
    children.push(paragraph(textRuns(local.noActionItems), meetingRtl, { after: 200 }))
  }

  // Transcript: direction per segment language.
  children.push(heading(t.exportHeadingTranscript, HeadingLevel.HEADING_2))
  if (meeting.transcript?.length) {
    for (const segment of meeting.transcript) {
      const segmentRtl = isRtlLanguage(segment.language ?? meeting.language)
      const runs = [
        ltrRun(formatMs(segment.startMs), { color: "999999", size: 18 }),
        ...textRuns(" "),
        ...textRuns(`${segment.speaker}: `, { bold: true, size: 20 }),
        ...textRuns(segment.text, { size: 20 }),
      ]

      children.push(paragraph(runs, segmentRtl, { after: 60 }))
    }
  } else {
    children.push(paragraph(textRuns(local.noTranscript), meetingRtl, { after: 200 }))
  }

  // Footer
  children.push(new Paragraph({ text: "" }))
  children.push(
    paragraph(
      textRuns(local.processedBy(new Date().toISOString().split("T")[0]), {
        italics: true,
        color: "999999",
        size: 16,
      }),
      meetingRtl
    )
  )

  const doc = new Document({
    creator: "MeetSum",
    title: meeting.title,
    sections: [{ children }],
  })

  return Buffer.from(await Packer.toBuffer(doc))
}
