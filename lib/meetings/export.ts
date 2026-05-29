import type { MeetingRecord } from "@/lib/meetings/repository"

function formatMs(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0")
  const seconds = (totalSeconds % 60).toString().padStart(2, "0")

  return `${minutes}:${seconds}`
}

const taskLabels: Record<string, string> = {
  "audio.transcribe": "Transcription",
  "transcript.clean": "Transcript cleanup",
  "summary.generate": "Summary generation",
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

export function renderMeetingMarkdown(meeting: MeetingRecord): string {
  const lines = [
    `# ${meeting.title}`,
    "",
    `- Date: ${new Date(meeting.startedAt).toLocaleString()}`,
    `- Source: ${meeting.source}`,
    `- Language: ${meeting.language}`,
    `- Status: ${meeting.status}`,
    `- Participants: ${
      meeting.participantDetails?.map((participant) => participant.name).join(", ") ||
      meeting.participants.join(", ") ||
      "None recorded"
    }`,
    "",
    "## Overview",
    meeting.summary?.overview || "No summary is available yet.",
    "",
    "## Decisions",
    ...(meeting.summary?.decisions.length
      ? meeting.summary.decisions.map((decision) => `- ${decision}`)
      : ["- No decisions extracted yet."]),
    "",
    "## Action Items",
    ...(meeting.summary?.actionItems.length
      ? meeting.summary.actionItems.map(
          (item) =>
            `- [${item.status === "done" ? "x" : " "}] ${item.title}${
              item.owner ? ` (${item.owner})` : ""
            }${item.dueDate ? ` - due ${item.dueDate}` : ""}`
        )
      : ["- No action items extracted yet."]),
    "",
    "## Transcript",
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
      ? meeting.transcript.map(
          (segment) =>
            `- ${formatMs(segment.startMs)} ${segment.speaker}: ${segment.text}`
        )
      : ["No transcript is available yet."]),
    "",
    ...renderProviderMetadata(meeting),
  ]

  return lines.join("\n")
}

function escapePdfText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
}

export function renderMeetingPdf(meeting: MeetingRecord): Buffer {
  const allLines = renderMeetingMarkdown(meeting)
    .replace(/^#+\s*/gm, "")
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.length <= 92) return [line]

      const chunks: string[] = []
      for (let index = 0; index < line.length; index += 92) {
        chunks.push(line.slice(index, index + 92))
      }
      return chunks
    })

  const linesPerPage = 52
  const pages: string[][] = []
  for (let i = 0; i < allLines.length; i += linesPerPage) {
    pages.push(allLines.slice(i, i + linesPerPage))
  }
  if (!pages.length) pages.push([" "])

  // Build PDF objects: catalog, pages, font, then per-page (page + stream)
  const objects: string[] = []

  // 1: Catalog → references Pages (object 2)
  objects.push("<< /Type /Catalog /Pages 2 0 R >>")

  // 2: Pages → will be filled after we know page refs
  const pageRefs = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")
  objects.push(
    `<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`
  )

  // Per page: page object + content stream
  for (const [pageIndex, pageLines] of pages.entries()) {
    const fontObjIndex = 3 + pages.length * 2
    const streamObjIndex = 3 + pageIndex * 2 + 1

    const content = [
      "BT",
      `/F1 10 Tf`,
      "50 790 Td",
      "14 TL",
      ...pageLines.map((line) => `(${escapePdfText(line || " ")}) Tj T*`),
      "ET",
    ].join("\n")

    // Page object
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${fontObjIndex} 0 R >> >> /Contents ${streamObjIndex} 0 R >>`
    )
    // Content stream
    objects.push(
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
    )
  }

  // Font object (last)
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

  const parts = ["%PDF-1.4\n"]
  const offsets = [0]

  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(parts.join("")))
    parts.push(`${index + 1} 0 obj\n${object}\nendobj\n`)
  }

  const xrefOffset = Buffer.byteLength(parts.join(""))
  parts.push(`xref\n0 ${objects.length + 1}\n`)
  parts.push("0000000000 65535 f \n")
  for (const offset of offsets.slice(1)) {
    parts.push(`${offset.toString().padStart(10, "0")} 00000 n \n`)
  }
  parts.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  )

  return Buffer.from(parts.join(""), "utf8")
}

export async function renderMeetingDocx(meeting: MeetingRecord): Promise<Buffer> {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
  } = await import("docx")

  const children: InstanceType<typeof Paragraph>[] = []

  // Title
  children.push(
    new Paragraph({
      text: meeting.title,
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.LEFT,
    })
  )

  // Metadata
  const meta = [
    `Date: ${new Date(meeting.startedAt).toLocaleString()}`,
    `Source: ${meeting.source}`,
    `Language: ${meeting.language}`,
    `Status: ${meeting.status}`,
    `Participants: ${
      meeting.participantDetails?.map((p) => p.name).join(", ") ||
      meeting.participants.join(", ") ||
      "None recorded"
    }`,
  ]

  for (const line of meta) {
    children.push(new Paragraph({ text: line, spacing: { after: 80 } }))
  }

  children.push(new Paragraph({ text: "" }))

  // Overview
  children.push(
    new Paragraph({ text: "Overview", heading: HeadingLevel.HEADING_2 })
  )
  children.push(
    new Paragraph({
      text: meeting.summary?.overview || "No summary is available yet.",
      spacing: { after: 200 },
    })
  )

  // Decisions
  children.push(
    new Paragraph({ text: "Decisions", heading: HeadingLevel.HEADING_2 })
  )

  if (meeting.summary?.decisions.length) {
    for (const decision of meeting.summary.decisions) {
      children.push(
        new Paragraph({
          text: decision,
          bullet: { level: 0 },
          spacing: { after: 80 },
        })
      )
    }
  } else {
    children.push(
      new Paragraph({
        text: "No decisions extracted yet.",
        spacing: { after: 200 },
      })
    )
  }

  // Action Items
  children.push(
    new Paragraph({ text: "Action Items", heading: HeadingLevel.HEADING_2 })
  )

  if (meeting.summary?.actionItems.length) {
    for (const item of meeting.summary.actionItems) {
      const label = item.status === "done" ? "☑" : "☐"
      const ownerPart = item.owner ? ` (${item.owner})` : ""
      const duePart = item.dueDate ? ` — due ${item.dueDate}` : ""

      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${label} ` }),
            new TextRun({
              text: item.title,
              bold: item.status !== "done",
              strike: item.status === "done",
            }),
            new TextRun({ text: `${ownerPart}${duePart}`, italics: true }),
          ],
          spacing: { after: 80 },
        })
      )
    }
  } else {
    children.push(
      new Paragraph({
        text: "No action items extracted yet.",
        spacing: { after: 200 },
      })
    )
  }

  // Transcript
  children.push(
    new Paragraph({ text: "Transcript", heading: HeadingLevel.HEADING_2 })
  )

  if (meeting.transcript?.length) {
    for (const segment of meeting.transcript) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${formatMs(segment.startMs)} `,
              color: "999999",
              size: 18,
            }),
            new TextRun({
              text: `${segment.speaker}: `,
              bold: true,
              size: 20,
            }),
            new TextRun({ text: segment.text, size: 20 }),
          ],
          spacing: { after: 60 },
        })
      )
    }
  } else {
    children.push(
      new Paragraph({
        text: "No transcript is available yet.",
        spacing: { after: 200 },
      })
    )
  }

  // Metadata footer
  children.push(new Paragraph({ text: "" }))
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Processed by MeetSum on ${new Date().toISOString().split("T")[0]}`,
          italics: true,
          color: "999999",
          size: 16,
        }),
      ],
    })
  )

  const doc = new Document({
    creator: "MeetSum",
    title: meeting.title,
    sections: [{ children }],
  })

  const buffer = await Packer.toBuffer(doc)

  return Buffer.from(buffer)
}

