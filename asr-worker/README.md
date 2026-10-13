# MeetSum ASR worker (RunPod serverless)

GPU worker for diarized Hebrew transcription, used by the `runpod-ivrit`
provider (`lib/ai/asr/providers/runpod-ivrit.ts`) when
`RUNPOD_ASR_WORKER=meetsum`, and by the `modal-worker` provider when deployed
on Modal (see "Deploy on Modal (free credits)").

Pipeline (`pipeline.py`): fetch audio (presigned URL or base64 blob, capped by
`MAX_AUDIO_BYTES`) → ffmpeg 16 kHz mono WAV → **faster-whisper**
(`ivrit-ai/whisper-large-v3-turbo-ct2`, word timestamps, VAD,
`condition_on_previous_text=False`, confidence thresholds, glossary `hotwords`
/ optional `initial_prompt`) → **pyannote** `speaker-diarization-community-1`
on CUDA (exclusive diarization + per-speaker embeddings) → `merge.py` assigns
each word to a speaker (max overlap → nearest turn within 500 ms → previous
speaker) → `meetsum-asr/v1` JSON (`schema.py`).

If diarization fails the transcript is still returned (`diarization: "none"`
plus a `diarization_failed` warning). Failures return `{"error": ...}`
(RunPod marks the job FAILED). Only an ffmpeg decode failure adds
`"error_kind": "bad_media"` (and a `[bad_media]` message prefix); MeetSum
treats exactly that as permanent `bad_input`. Download failures, policy
rejections (`Rejected: ...`) and worker errors stay retryable, so MeetSum's
next provider can try.

## Input policy

- **Audio URLs**: `https` only, redirects are never followed, and when
  `ASR_ALLOWED_AUDIO_HOSTS` is set (comma-separated; an entry starting with
  `.` matches subdomains, e.g. `media.example.com,.r2.cloudflarestorage.com`)
  the host must be listed. Set it to your `S3_PUBLIC_ENDPOINT` host in
  production.
- **Models**: `job.model` must be in `ASR_ALLOWED_MODELS` (comma-separated),
  default `ASR_MODEL` plus `ASR_MODEL_MULTILINGUAL` (`large-v3-turbo`, what
  MeetSum sends for non-Hebrew meetings). Anything else is rejected before
  download.
- **ffmpeg** only reads local files and pipes (`-protocol_whitelist file,pipe`).

The default `RUNPOD_ASR_WORKER=ivrit` instead targets the public ivrit-ai
RunPod image (see "Alternative" below); this worker exists for full control
over diarization, embeddings (voiceprints) and the output schema.

## Files

| File | Purpose |
| --- | --- |
| `handler.py` | RunPod entry point; validates input, runs the pipeline |
| `pipeline.py` | download, ffmpeg, faster-whisper, pyannote (lazy GPU imports) |
| `merge.py` | pure word→speaker assignment |
| `schema.py` | `meetsum-asr/v1` input parsing and output building |
| `modal_app.py` | Modal deployment (submit/poll web API + GPU class), see below |
| `tests/test_modal_app.py` | pytest: Modal auth / request validation, no `modal` package needed |
| `tests/test_merge.py` | pytest: merge + schema, no GPU needed |
| `tests/test_pipeline.py` | pytest: URL/model policy, ffmpeg args, handler error mapping |
| `test_input.json` | sample job for `runpod` local testing |

## Tests (no GPU)

```bash
python -m pytest asr-worker/tests
```

Only the standard library and pytest are needed: GPU dependencies are
imported lazily inside `pipeline.py`.

## Build and push

```bash
cd asr-worker
docker build --platform linux/amd64 -t <registry>/meetsum-asr-worker:2026.10 .
docker push <registry>/meetsum-asr-worker:2026.10
```

The image bakes the Whisper model (~1.6 GB) to keep cold starts short. Use an
immutable tag per release and update the RunPod template to it.

Local smoke test on a CUDA machine (RunPod SDK local mode):

```bash
docker run --gpus all --rm -e HF_TOKEN=... -v "$PWD/test_input.json:/app/test_input.json" \
  <registry>/meetsum-asr-worker:2026.10 python -u handler.py --test_input "$(cat test_input.json)"
```

Replace the placeholder URL in `test_input.json` with a presigned URL to a
short clip first.

## Hugging Face token

`pyannote/speaker-diarization-community-1` is gated:

1. Accept the model conditions on Hugging Face with the account that owns the
   token.
2. Create a **read-only, fine-grained** token limited to that repository.
3. Store it as a RunPod **secret** (`HF_TOKEN` → `{{ RUNPOD_SECRET_hf_token }}`
   in the endpoint env). Never bake it into the image, never commit it, never
   pass it in job input.

The token is only used to download the model on first use; with a network
volume mounted at `/models` (`HF_HOME=/models/hf`) later cold starts reuse the
cached weights.

## RunPod endpoint settings

| Setting | Value |
| --- | --- |
| GPU | 24 GB class (L4 / A5000 / RTX 4090); 16 GB works for short meetings only |
| Min workers | 0 |
| Max workers | 2 |
| Idle timeout | 5 s |
| FlashBoot | on |
| Execution timeout | 3600 s |
| Container disk | 20 GB |
| Network volume (optional) | mounted at `/models` for the pyannote cache |
| Env | `HF_TOKEN` (secret), `ASR_ALLOWED_AUDIO_HOSTS=<S3_PUBLIC_ENDPOINT host>`, optional `ASR_ALLOWED_MODELS`, `ASR_MODEL_MULTILINGUAL`, `MAX_AUDIO_BYTES`, `ASR_COMPUTE_TYPE=float16` |

MeetSum side (`.env`):

```
RUNPOD_API_KEY=...                 # RunPod API key with endpoint access only
RUNPOD_ASR_ENDPOINT_ID=<endpoint id>
RUNPOD_ASR_WORKER=meetsum
S3_PUBLIC_ENDPOINT=https://media.example.com   # presigned handoff (else ≤ 7 MB raw audio as base64 blobs)
```

`RUNPOD_ASR_TIMEOUT_MS` defaults to max(10 min, 0.5 × duration + 5 min);
MeetSum cancels the job on timeout or abort.

## Alternative: ivrit-ai RunPod image (default)

`RUNPOD_ASR_WORKER=ivrit` (default) speaks the ivrit-ai serverless worker
format (`{type: "url"|"blob", model, engine: "stable-whisper",
transcribe_args: {language, diarize, word_timestamps, hotwords}}`). Deploy the
ivrit-ai image from their RunPod template, point `RUNPOD_ASR_ENDPOINT_ID` at
it, and MeetSum normalizes its generator output. It provides diarized words
but no speaker embeddings (voiceprint suggestions stay unavailable).

## Cost (estimates, verify against your RunPod invoice)

MeetSum records `executionTime × RUNPOD_PRICE_PER_SECOND` (default
`0.00019` $/s ≈ $0.68/h of GPU) on every ASR `ai_run`.

| Audio | GPU time (turbo + diarization, RTF ≈ 0.05–0.1) | RunPod cost | Soniox (`0.10` $/h) |
| --- | --- | --- | --- |
| 15 min | 45–90 s | $0.009–0.017 | $0.025 |
| 1 h | 3–6 min | $0.034–0.068 | $0.10 |
| 3 h | 9–18 min | $0.10–0.21 | $0.30 |

Cold starts add queue time (`delayTime`, not billed as execution) but FlashBoot
plus the baked model keeps them to seconds.

## Deploy on Modal (free credits)

The same worker runs on [Modal](https://modal.com) serverless GPUs through
`modal_app.py`, used by MeetSum's `modal-worker` provider
(`lib/ai/asr/providers/modal-worker.ts`). Modal's Starter plan includes a
monthly compute credit ($30 at the time of writing; check their pricing page),
which covers dozens of hours of meetings at T4 rates, so a small deployment
can cost nothing.

```bash
pip install modal && modal setup          # one-time login
cd asr-worker
modal secret create huggingface HF_TOKEN=hf_...          # read token, pyannote terms accepted
modal secret create meetsum-asr-auth MEETSUM_ASR_TOKEN="$(openssl rand -hex 32)"
modal deploy modal_app.py                 # prints https://<workspace>--meetsum-asr-web.modal.run
```

Then in MeetSum's env:

```dotenv
MODAL_ASR_URL=https://<workspace>--meetsum-asr-web.modal.run
MODAL_ASR_TOKEN=<the MEETSUM_ASR_TOKEN value>
# MODAL_PRICE_PER_SECOND=0.000164   # T4 default; 0.000222 for L4
```

How it is wired:

- **API** (CPU `web` function, FastAPI): `POST /v1/jobs` (`{"input": <meetsum-asr/v1>}`),
  `GET /v1/jobs/{id}`, `POST /v1/jobs/{id}/cancel`, `GET /health`. Modal caps a
  synchronous web request at ~150 s, so transcription is submit/poll, like
  RunPod. Every route requires `Authorization: Bearer <MEETSUM_ASR_TOKEN>`;
  without the secret every request is rejected. Input is validated with
  `schema.py` before any GPU starts.
- **GPU** (`AsrWorker` class): `MODAL_ASR_GPU` (default `T4`; `L4` is faster),
  calls `handler.handler`, so the input policy, error mapping and
  `bad_media` marker are identical to RunPod. Execution time is returned as
  `executionTime` for MeetSum's cost record.
- **Models** are cached in the `meetsum-asr-models` Volume (`HF_HOME=/models/hf`):
  only the first cold start downloads Whisper (~1.6 GB) and pyannote.
- **Knobs** (env at deploy time): `MODAL_SCALEDOWN_WINDOW_S` (idle keep-warm,
  default 120 s, billed), `MODAL_MAX_CONTAINERS` (default 2),
  `MODAL_JOB_TIMEOUT_S` (default 3600), `ASR_ALLOWED_AUDIO_HOSTS` /
  `ASR_ALLOWED_MODELS` as above.

Cost: Modal bills the container's whole lifetime (cold start, model load,
the scale-down window), so the recorded `executionTime × MODAL_PRICE_PER_SECOND`
is a lower bound. A T4 is slower than RunPod's default GPUs (estimate RTF
0.1–0.2 with diarization, unmeasured), i.e. roughly $0.06–0.12 per meeting
hour plus ~1–2 min of cold start per burst.

## Re-recording fixtures

The MeetSum unit tests use hand-written, synthetic fixtures
(`tests/fixtures/asr/providers/*.json`, all marked `"_synthetic": true`). Once
an endpoint is live:

1. Transcribe a short **consented, non-sensitive** clip with each worker mode.
2. Save the final `/status/{id}` JSON; replace names, emails and any
   identifying words in the transcript with neutral text; drop the presigned
   URL.
3. Replace the fixture, remove `"_synthetic": true`, add `"_recorded": "<date>"`,
   and update test expectations where the real shape differs.
