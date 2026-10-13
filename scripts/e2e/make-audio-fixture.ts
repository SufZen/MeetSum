/**
 * `npm run e2e:fixtures` (docs/parity/m10.md, "Audio fixture"). Writes, once,
 * the committed e2e media and its fake-ASR fixture:
 *
 * - tests/fixtures/e2e/media/he-en-30s.wav: 30 s, 16 kHz mono, a
 *   deterministic tone sequence (no voice, so no consent issue; < 1 MB);
 * - tests/fixtures/e2e/asr/<sha256 of the wav>.json: the `verbose_json`
 *   "speech" for it (code-switched Hebrew/English with word timestamps)
 *   plus `x_meetsum_fixture: { id, tones }` for the fake ASR.
 *
 * `--check` regenerates in memory and fails when the committed files differ.
 * The summary/title replays for this fixture live in
 * tests/fixtures/e2e/llm-replay/<task>/he-en-30s.json.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

import { E2E_SAMPLE_RATE, toneSequence, toneWav } from "@/lib/testing/e2e-audio"

export const FIXTURE_ID = "he-en-30s"
export const MEDIA_FILE = path.join("tests", "fixtures", "e2e", "media", `${FIXTURE_ID}.wav`)
export const ASR_DIR = path.join("tests", "fixtures", "e2e", "asr")
const TONE_SEED = 3

/**
 * The fixture "speech": one sentence per segment, 1.5 s gaps between them
 * (the ASR segmenter splits at gaps > 1.2 s), Hebrew and English segments.
 */
export const FIXTURE_SENTENCES: Array<{ start: number; end: number; text: string }> = [
  { start: 0.5, end: 4.0, text: "בוקר טוב לכולם, נתחיל בסקירת התקציב של Q4." },
  { start: 5.5, end: 9.5, text: "Let's start with the marketing budget for the launch." },
  { start: 11.0, end: 15.0, text: "הוחלט להגדיל את תקציב השיווק בעשרה אחוזים." },
  { start: 16.5, end: 20.5, text: "דנה תשלח את התחזית המעודכנת עד יום חמישי." },
  { start: 22.0, end: 25.5, text: "We still need sign-off from finance on the vendor contract." },
  { start: 27.0, end: 29.5, text: "תודה רבה, נתראה בשבוע הבא." },
]

const round = (value: number) => Math.round(value * 1000) / 1000

export function buildAsrResponse(): Record<string, unknown> {
  const segments = FIXTURE_SENTENCES.map((sentence, id) => {
    const tokens = sentence.text.split(/\s+/)
    const step = (sentence.end - sentence.start) / tokens.length
    const words = tokens.map((word, index) => ({
      word,
      start: round(sentence.start + index * step),
      end: round(sentence.start + (index + 1) * step - 0.05),
      probability: 0.97,
    }))

    return { id, seek: 0, start: sentence.start, end: sentence.end, text: ` ${sentence.text}`, avg_logprob: -0.12, words }
  })

  return {
    task: "transcribe",
    language: "hebrew",
    duration: 30,
    text: FIXTURE_SENTENCES.map((sentence) => sentence.text).join(" "),
    segments,
    words: segments.flatMap((segment) => segment.words),
  }
}

export function buildFixtures(): { wav: Buffer; sha256: string; asrJson: string } {
  const tones = toneSequence(TONE_SEED)
  const wav = toneWav(tones, E2E_SAMPLE_RATE)
  const sha256 = createHash("sha256").update(wav).digest("hex")
  const asrJson = `${JSON.stringify({ ...buildAsrResponse(), x_meetsum_fixture: { id: FIXTURE_ID, tones } }, null, 2)}\n`

  return { wav, sha256, asrJson }
}

function main() {
  const { wav, sha256, asrJson } = buildFixtures()
  const asrFile = path.join(ASR_DIR, `${sha256}.json`)

  if (process.argv.includes("--check")) {
    const problems: string[] = []

    if (!existsSync(MEDIA_FILE) || !readFileSync(MEDIA_FILE).equals(wav)) problems.push(`${MEDIA_FILE} differs`)
    if (!existsSync(asrFile) || readFileSync(asrFile, "utf8") !== asrJson) problems.push(`${asrFile} differs`)
    if (problems.length) {
      console.error(`e2e fixtures are stale (${problems.join("; ")}); run npm run e2e:fixtures`)
      process.exit(1)
    }
    console.log("e2e fixtures are current")
    return
  }

  mkdirSync(path.dirname(MEDIA_FILE), { recursive: true })
  mkdirSync(ASR_DIR, { recursive: true })
  writeFileSync(MEDIA_FILE, wav)
  // One fixture per media file: drop stale ones of the same id.
  for (const name of readdirSync(ASR_DIR)) {
    const file = path.join(ASR_DIR, name)

    if (file !== asrFile && name.endsWith(".json") && readFileSync(file, "utf8").includes(`"id": "${FIXTURE_ID}"`)) unlinkSync(file)
  }
  writeFileSync(asrFile, asrJson)
  console.log(`Wrote ${MEDIA_FILE} (${wav.byteLength} bytes) and ${asrFile}`)
}

if (process.argv[1] && /make-audio-fixture/.test(process.argv[1])) main()
