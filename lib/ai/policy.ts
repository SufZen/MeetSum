export type TranscriptionQuality = {
  language: string
  confidence: number
  diarizationConfidence?: number
}

const HEBREW_LANGUAGE_CODES = new Set(["he", "heb", "iw"])

export function shouldEscalateTranscription(
  quality: TranscriptionQuality,
): boolean {
  const isHebrew = HEBREW_LANGUAGE_CODES.has(quality.language.toLowerCase())
  const confidenceFloor = isHebrew ? 0.88 : 0.82
  const diarizationFloor = isHebrew ? 0.84 : 0.78

  if (quality.confidence < confidenceFloor) {
    return true
  }

  return (
    typeof quality.diarizationConfidence === "number" &&
    quality.diarizationConfidence < diarizationFloor
  )
}

export function summarizeInHebrewPrompt(meetingTitle: string): string {
  return [
    `סכם את הפגישה בעברית: ${meetingTitle}.`,
    "שמור על שמות, מונחים מקצועיים, החלטות, משימות, אחריות ותאריכים.",
    "אם יש אי-ודאות בתמלול, סמן אותה בלי להמציא פרטים.",
  ].join("\n")
}
