# Runbook: free-tier and low-cost ASR

How to run MeetSum's transcription for free in development and for under
~$5/month in a small production install. The ASR router (docs/parity/m3.md,
`lib/ai/asr/`) tries providers in order and skips any without credentials, so
each option below is just a set of env vars. Default Hebrew chain:

```
runpod-ivrit → modal-worker → soniox → local-whisper-chunked
```

Prices and free allowances below were checked in October 2026 and change
often. Confirm them on each vendor's pricing page before you rely on them.

| Option | Provider slot | Cost | Hebrew quality | Diarization |
| --- | --- | --- | --- | --- |
| Local ivrit-ai (faster-whisper / whisper.cpp) | `local-whisper-chunked` | $0 (your hardware) | Best (ivrit-ai fine-tune) | No |
| Groq hosted Whisper | `local-whisper-chunked` | $0 within free limits | Generic large-v3-turbo, weaker on Hebrew | No |
| Modal + our `asr-worker` | `modal-worker` | $0 within the monthly credit | Best (ivrit-ai) | Yes (pyannote) |
| RunPod serverless | `runpod-ivrit` | ~$1–2/month for light use | Best (ivrit-ai) | Yes |
| Soniox async | `soniox` | $0.10 per audio hour | Good | Yes |

## 1. Zero-cost development

### a. Local ivrit-ai with an OpenAI-compatible server

Any server that implements `POST /v1/audio/transcriptions` works in the
`local-whisper-chunked` slot. MeetSum cuts audio into ~10-minute chunks at
silences and sends them one at a time.

**faster-whisper** (recommended; word timestamps and `hotwords` supported):

- Our own server: `docs/runbooks/laptop-hebrew-asr/` (`app.py`, validated on
  CPU/int8 with `ivrit-ai/whisper-large-v3-turbo-ct2`).
- Or the community `speaches` (formerly faster-whisper-server) image, loading
  the same model.

```dotenv
LOCAL_TRANSCRIPTION_URL=http://localhost:8771
LOCAL_TRANSCRIPTION_MODEL=ivrit-ai/whisper-large-v3-turbo-ct2
LOCAL_TRANSCRIPTION_SEND_HOTWORDS=true
```

**whisper.cpp** (no Python; good on Apple Silicon and plain CPUs): download a
ggml conversion of the ivrit-ai turbo model (ivrit-ai publishes ggml builds on
Hugging Face) and start the bundled server with an OpenAI-style path:

```bash
./build/bin/whisper-server -m ggml-ivrit-large-v3-turbo.bin \
  --host 127.0.0.1 --port 8771 --inference-path /v1/audio/transcriptions -l he
```

Caveats: whisper.cpp has no `/v1/models`, so the MeetSum health check shows
it unhealthy even though transcription works. It also ignores `hotwords`
(set `LOCAL_TRANSCRIPTION_SEND_HOTWORDS=false`), and when it returns only
segment timings MeetSum synthesizes word timings and adds the
`synthetic_word_timings` warning.

The local slot never diarizes: every word is `Speaker 1`, with a
`diarization_unavailable` warning.

### b. Groq (hosted, free tier)

Groq exposes an OpenAI-compatible Whisper API. It plugs into the same slot:

```dotenv
LOCAL_TRANSCRIPTION_URL=https://api.groq.com/openai
LOCAL_TRANSCRIPTION_MODEL=whisper-large-v3-turbo
LOCAL_TRANSCRIPTION_API_KEY=gsk_...
LOCAL_TRANSCRIPTION_SEND_HOTWORDS=false
# Leave LOCAL_TRANSCRIPTION_LANGUAGE unset: MeetSum sends each meeting's language.
```

- The key goes out as `Authorization: Bearer …` on transcription requests and
  on the `/v1/models` health check. It is never logged: provider errors pass
  through `redactAsrErrorMessage`, which strips bearer tokens.
- `hotwords` is a faster-whisper extension, so turn it off for Groq or OpenAI.
  The glossary can still reach the model as a prompt
  (`MEETSUM_ASR_USE_INITIAL_PROMPT=true`). MeetSum keeps the prompt within
  Whisper's 224-token limit by dropping whole terms from the end.
- File limit: 25 MB per request on the free tier. MeetSum's chunks are
  10 minutes of 16 kHz mono Opus at 24 kbit/s, about 2 MB, so the limit is
  never reached.
- The free tier has request and audio-seconds-per-day limits; long backfills
  hit HTTP 429 (`rate_limit`, retryable). The router then falls through to the
  next provider and the circuit breaker cools Groq down.
- No diarization (same warning as above). The model is generic
  `whisper-large-v3-turbo`, not the ivrit-ai fine-tune, so Hebrew accuracy is
  lower. Use it as a fallback or for English meetings.

### c. Diarization with a free Hugging Face token

Speaker labels come from pyannote (`speaker-diarization-community-1`) inside
our `asr-worker`. The model is gated but free:

1. Create a free Hugging Face account and a **read** token.
2. Accept the user conditions on the pyannote model pages.
3. Give the token to the worker: `HF_TOKEN` on RunPod, or the `huggingface`
   Modal Secret (see `asr-worker/README.md`).

The worker needs a CUDA GPU, which is why free diarization means Modal's
credit (section 2) rather than a laptop.

## 2. Small production (under ~$5/month)

### a. Modal free credit + our asr-worker (`modal-worker`)

Modal's Starter plan includes a monthly compute credit ($30 at the time of
writing). `asr-worker/modal_app.py` runs the same ivrit-ai + pyannote pipeline
as the RunPod image on a T4 and scales to zero. Deploy steps are in
`asr-worker/README.md` → "Deploy on Modal (free credits)". Then:

```dotenv
MODAL_ASR_URL=https://<workspace>--meetsum-asr-web.modal.run
MODAL_ASR_TOKEN=<MEETSUM_ASR_TOKEN from the meetsum-asr-auth secret>
MODAL_PRICE_PER_SECOND=0.000164   # T4; 0.000222 for L4
```

- At an estimated $0.06–0.12 of T4 time per meeting hour, the credit covers
  far more than a small team records in a month. Cold starts (~1–2 min) and
  the 120 s keep-warm window are billed too.
- Audio reaches the worker as a presigned URL (`S3_PUBLIC_ENDPOINT`) or as an
  inline base64 blob (≤ `MODAL_MAX_BLOB_BYTES`, default
  `RUNPOD_MAX_BLOB_BYTES` = 7 MB, about 38 minutes). Set
  `S3_PUBLIC_ENDPOINT` for longer meetings.
- MeetSum records `executionTime × MODAL_PRICE_PER_SECOND` per run as a
  `gpu_seconds` cost. Treat it as a lower bound on the Modal invoice.

### b. RunPod serverless (`runpod-ivrit`), about $1–2/month

Pay-per-second GPU with scale-to-zero. At ~$0.03–0.07 per meeting hour
(asr-worker/README.md → Cost), 20–30 meeting hours a month cost about
$1–2. Use the public ivrit-ai template (`RUNPOD_ASR_WORKER=ivrit`) or our
image (`RUNPOD_ASR_WORKER=meetsum`, adds voice embeddings).

### c. Soniox ($0.10 per audio hour)

No infrastructure, diarization included. 40 meeting hours cost $4.
`SONIOX_API_KEY=…`. It is the default first choice for non-Hebrew meetings.

A sensible low-cost chain: `MEETSUM_ASR_CHAIN=modal-worker,soniox,local-whisper-chunked`
(Modal first while the credit lasts, Soniox as a paid fallback, Groq or a
local server last).

### d. Lemonade on a laptop + Gemini fallback

The v0.6.0 production setup: a Lemonade (or any OpenAI-compatible
faster-whisper) server on a laptop, reached over Tailscale, with Gemini as
the fallback while the laptop is asleep or offline. In v0.7 write it as an
explicit chain:

```dotenv
MEETSUM_ASR_CHAIN=local-whisper-chunked
MEETSUM_ASR_ALLOW_GEMINI=true
LOCAL_TRANSCRIPTION_URL=http://<laptop-tailscale-name>:8000
LOCAL_TRANSCRIPTION_MODEL=ivrit-ai/whisper-large-v3-turbo-ct2
LOCAL_TRANSCRIPTION_SEND_HOTWORDS=true
GOOGLE_GEMINI_API_KEY=...        # or Vertex AI (GOOGLE_GENAI_USE_VERTEXAI=true + project/location/credentials)
GEMINI_TIER=paid                 # see the privacy note below
```

The resulting Hebrew chain is `local-whisper-chunked → gemini-legacy`.
`MEETSUM_ASR_ALLOW_GEMINI=true` appends Gemini to whatever
`MEETSUM_ASR_CHAIN` lists; without a Gemini key or Vertex it drops out again.

- **Legacy `MEETSUM_TRANSCRIPTION_PROVIDER=auto`** still means exactly this
  chain while `MEETSUM_ASR_CHAIN` is unset (v0.7.1 restored the v0.6.0
  meaning; v0.7.0 had silently dropped Gemini). The app and the worker log a
  deprecation warning at boot. Once `MEETSUM_ASR_CHAIN` is set the legacy
  variable is ignored; remove it.
- **Single-provider warning.** At boot the app and the worker warn when the
  Hebrew chain has only one *configured* provider (for example
  `MEETSUM_ASR_CHAIN=local-whisper-chunked` without the Gemini opt-in), because
  every Hebrew transcription then fails while that provider is down.
- **Privacy (`GEMINI_TIER`).** With this recipe the full meeting audio goes to
  Gemini whenever the laptop is unreachable. On `GEMINI_TIER=free` Google may
  use it to improve its products and humans may review it (health and ops
  status show a warning). Keep a paid key or Vertex AI for confidential
  meetings, or leave `MEETSUM_ASR_ALLOW_GEMINI=false` and accept failed
  transcriptions (retry later) while the laptop is away.
- Gemini is an LLM transcript: no word timings (`synthetic_word_timings`) and
  guessed speakers. It is a fallback, not a replacement for ivrit-ai.

## 3. Free credits for benchmarking (not yet integrated)

These vendors offer one-time signup credit that is enough to benchmark them
with `scripts/evaluate-hebrew-asr.ts` once an adapter exists:

- **Deepgram**: $200 of free credit.
- **AssemblyAI**: $50 of free credit.

Neither is a MeetSum ASR provider yet. Adding one means a new
`lib/ai/asr/providers/*.ts` with a `create…Provider` factory, an
`AsrProviderId`, and an entry in `tests/asr-no-network.test.ts`.

## 4. Privacy notes

Meeting audio is sensitive. Before turning on a hosted tier:

- **Gemini free tier**: Google may use free-tier Gemini API inputs and outputs
  to improve its products (paid tiers do not). Keep
  `MEETSUM_ASR_ALLOW_GEMINI=false` (the default) for real meetings, or use a
  paid key or Vertex AI. This also applies to the legacy
  `MEETSUM_TRANSCRIPTION_PROVIDER=auto`, which turns the Gemini fallback on
  (section 2d).
- **Groq**: enable **Zero Data Retention** in the Groq console's data controls
  so audio is not stored after processing. Check the current terms for the free tier.
- **Modal / RunPod**: the audio is processed in your own container. Presigned
  handoff URLs expire (`MEETSUM_ASR_HANDOFF_URL_TTL_SECONDS`) and the
  `asr-handoff/` object is deleted after every attempt. Model caches hold
  weights only, not audio.
- **Soniox, Deepgram, AssemblyAI**: read each vendor's retention and training
  policy and opt out of training where offered.
- **Local servers** keep everything on your hardware. Bind them to localhost
  or a private network (e.g. Tailscale) and never to a public interface.
