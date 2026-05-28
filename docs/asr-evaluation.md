# ASR Evaluation Guide

## Overview

MeetSum includes a Word Error Rate (WER) evaluation framework for testing transcription accuracy across providers and languages. Evaluations run against **private**, uncommitted audio samples.

## Manifest Format

Create a manifest at `.secrets/asr-eval/manifest.json`:

```json
{
  "samples": [
    {
      "id": "hebrew-standup-01",
      "audioPath": ".secrets/asr-eval/samples/hebrew-standup.webm",
      "referencePath": ".secrets/asr-eval/references/hebrew-standup.txt",
      "language": "he",
      "durationMs": 312000,
      "description": "5-minute Hebrew standup with 3 speakers"
    },
    {
      "id": "mixed-product-review",
      "audioPath": ".secrets/asr-eval/samples/mixed-product.webm",
      "referencePath": ".secrets/asr-eval/references/mixed-product.txt",
      "language": "mixed",
      "durationMs": 1800000,
      "description": "30-minute mixed Hebrew/English product review"
    }
  ]
}
```

## Reference Transcript Format

Reference transcripts (`.txt` files) should contain the expected text output, one segment per line:

```
שלום, בואו נתחיל את הפגישה
היום נדבר על הרבעון הבא
We need to finalize the Q3 roadmap by Friday
```

## Running Evaluations

```bash
# Run WER evaluation against all samples
npx tsx scripts/asr-evaluate.ts --manifest .secrets/asr-eval/manifest.json

# Run against a specific sample
npx tsx scripts/asr-evaluate.ts --manifest .secrets/asr-eval/manifest.json --sample hebrew-standup-01
```

## Evaluation Output

The script produces a JSON report:

```json
{
  "timestamp": "2026-05-28T10:00:00Z",
  "results": [
    {
      "sampleId": "hebrew-standup-01",
      "provider": "local-whisper",
      "model": "ivrit-ai/whisper-large-v3-turbo-ct2",
      "wer": 0.12,
      "substitutions": 3,
      "insertions": 1,
      "deletions": 2,
      "referenceWords": 50,
      "latencyMs": 15200
    }
  ]
}
```

## Operational Recommendations

| Duration | Recommended Provider | Notes |
|----------|---------------------|-------|
| < 15 min | `local-whisper` | ivrit-ai model handles short Hebrew well |
| > 15 min | `gemini` | CPU float32 can crash on long recordings |
| Mixed language | `gemini` | Better multilingual handling |

## Directory Structure

```
.secrets/asr-eval/
├── manifest.json
├── samples/
│   ├── hebrew-standup.webm
│   └── mixed-product.webm
└── references/
    ├── hebrew-standup.txt
    └── mixed-product.txt
```

> **Important**: The `.secrets/` directory is gitignored. Never commit audio samples, reference transcripts, or evaluation results.
