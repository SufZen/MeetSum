import type { MeetingRecord } from "@/lib/meetings/repository"

function formatMs(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0")
  const seconds = (totalSeconds % 60).toString().padStart(2, "0")

  return `${minutes}:${seconds}`
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
    ...(meeting.transcript?.length
      ? meeting.transcript.map(
          (segment) =>
            `- ${formatMs(segment.startMs)} ${segment.speaker}: ${segment.text}`
        )
      : ["No transcript is available yet."]),
    "",
  ]

  return lines.join("\n")
}

function escapePdfText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
}

export function renderMeetingPdf(meeting: MeetingRecord): Buffer {
  const text = renderMeetingMarkdown(meeting)
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
    .slice(0, 58)

  const content = [
    "BT",
    "/F1 10 Tf",
    "50 790 Td",
    "14 TL",
    ...text.map((line) => `(${escapePdfText(line || " ")}) Tj T*`),
    "ET",
  ].join("\n")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
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
