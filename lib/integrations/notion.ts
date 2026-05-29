import type { MeetingRecord } from "@/lib/meetings/repository"

/**
 * Build Notion page blocks from a MeetingRecord.
 * This creates the block structure without requiring the Notion SDK,
 * making it testable independently.
 */
export function buildNotionBlocks(meeting: MeetingRecord) {
  const blocks: NotionBlock[] = []

  // Overview
  blocks.push(heading2("Overview"))
  blocks.push(
    paragraph(meeting.summary?.overview ?? "No summary available yet.")
  )
  blocks.push(divider())

  // Decisions
  if (meeting.summary?.decisions.length) {
    blocks.push(heading2("Decisions"))
    for (const decision of meeting.summary.decisions) {
      blocks.push(bulletedListItem(decision))
    }
    blocks.push(divider())
  }

  // Action Items
  if (meeting.summary?.actionItems.length) {
    blocks.push(heading2("Action Items"))
    for (const item of meeting.summary.actionItems) {
      const label = item.owner ? `${item.title} (${item.owner})` : item.title
      blocks.push(toDo(label, item.status === "done"))
    }
    blocks.push(divider())
  }

  // Transcript excerpt (first 50 segments to avoid Notion block limits)
  if (meeting.transcript?.length) {
    blocks.push(heading2("Transcript"))
    const segments = meeting.transcript.slice(0, 50)
    const transcriptText = segments
      .map((s) => `[${formatMs(s.startMs)}] ${s.speaker}: ${s.text}`)
      .join("\n")
    blocks.push(codeBlock(transcriptText, "plain text"))

    if (meeting.transcript.length > 50) {
      blocks.push(
        callout(
          `Transcript truncated. ${meeting.transcript.length - 50} more segments available in MeetSum.`,
          "⚠️"
        )
      )
    }
  }

  // Metadata
  blocks.push(divider())
  blocks.push(
    callout(
      `Exported from MeetSum on ${new Date().toISOString().split("T")[0]}`,
      "📋"
    )
  )

  return blocks
}

/**
 * Build Notion page properties for the meeting.
 */
export function buildNotionProperties(meeting: MeetingRecord) {
  return {
    Name: {
      title: [{ text: { content: meeting.title } }],
    },
    Date: {
      date: { start: meeting.startedAt },
    },
    Status: {
      select: { name: meeting.status },
    },
    Source: {
      select: { name: meeting.source },
    },
    Language: {
      rich_text: [{ text: { content: meeting.language } }],
    },
    Participants: {
      rich_text: [
        {
          text: {
            content: (
              meeting.participantDetails?.map((p) => p.name) ??
              meeting.participants
            ).join(", "),
          },
        },
      ],
    },
  }
}

// --- Notion Block Helpers ---

type NotionBlock = {
  object: "block"
  type: string
  [key: string]: unknown
}

function heading2(text: string): NotionBlock {
  return {
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: [{ type: "text", text: { content: text } }],
    },
  }
}

function paragraph(text: string): NotionBlock {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: text } }],
    },
  }
}

function bulletedListItem(text: string): NotionBlock {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [{ type: "text", text: { content: text } }],
    },
  }
}

function toDo(text: string, checked: boolean): NotionBlock {
  return {
    object: "block",
    type: "to_do",
    to_do: {
      rich_text: [{ type: "text", text: { content: text } }],
      checked,
    },
  }
}

function codeBlock(text: string, language: string): NotionBlock {
  return {
    object: "block",
    type: "code",
    code: {
      rich_text: [{ type: "text", text: { content: text } }],
      language,
    },
  }
}

function divider(): NotionBlock {
  return {
    object: "block",
    type: "divider",
    divider: {},
  }
}

function callout(text: string, emoji: string): NotionBlock {
  return {
    object: "block",
    type: "callout",
    callout: {
      rich_text: [{ type: "text", text: { content: text } }],
      icon: { type: "emoji", emoji },
    },
  }
}

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0")
  const seconds = (totalSeconds % 60).toString().padStart(2, "0")
  return `${minutes}:${seconds}`
}
