# Runbook — Hebrew ASR on the Ryzen AI MAX laptop (ivrit-ai, CPU/int8)

> **⚠️ Development / ops documentation — NOT part of the application.**
> Nothing here is imported, built, or executed by MeetSum. These are manual
> steps + helper files you run by hand when setting up the laptop ASR host.

## Why

MeetSum's Hebrew ASR currently runs on the VPS `faster-whisper` container. The
VPS has only ~7.6 GB RAM shared across many services, so `large-v3-turbo`
transcription of long Hebrew meetings is fragile (it crashed on >15 min
recordings; the `int8` fix reduced but did not eliminate the risk). This runbook
moves Hebrew ASR to the **Ryzen AI MAX laptop** (16 Zen 5 cores, 128 GB) which
runs the **ivrit-ai Hebrew fine-tune** comfortably and crash-free.

### Hardware note (read once)

The ivrit fine-tune (`ivrit-ai/whisper-large-v3-turbo-ct2`) is a **CTranslate2**
model. CTranslate2 only GPU-accelerates on **NVIDIA/CUDA** — there is no AMD GPU
path. So on the Ryzen (AMD) laptop it runs **CPU-only**. That is fine: the
laptop's 16 Zen 5 cores at `int8` transcribe `large-v3-turbo` faster than
real-time and never hit the VPS's memory wall. This keeps the best Hebrew model.
(True laptop-GPU ASR would mean Lemonade's vanilla `Whisper-Large-v3-Turbo` — no
ivrit fine-tune — or a whisper.cpp+Vulkan conversion; both are later, optional.)

## Topology after this runbook

```
Meeting → VPS worker → POST audio → http://100.119.125.14:8771/v1/audio/transcriptions
                                     (laptop faster-whisper, ivrit, int8, over Tailscale)
                       └─ laptop offline / errors → falls back to Gemini (automatic)
```

- `MEETSUM_TRANSCRIPTION_PROVIDER=auto` already routes Hebrew/mixed → local
  Whisper, and falls back to Gemini on any failure (honest-failure fixes are
  live). So when the laptop is asleep, meetings still transcribe via Gemini.
- The laptop's existing **Lemonade** server (port 13305, managed by
  `lemonade-watchdog`) is unrelated and stays as-is — it serves Hermes/RealizeOS.
  This is a **separate** faster-whisper service on a **new port (8771)**.

---

## ✅ VALIDATED SETUP (native Windows) — use this, not the Docker path below

> The Docker/WSL2 approach in "Part A" below was **abandoned**: Docker Desktop
> won't run headless on the laptop, WSL Python was too new for `ctranslate2`,
> and `netsh portproxy` silently **drops the long idle connections** a multi-
> minute transcription needs. The setup below is what actually runs in
> production and was validated end-to-end on a real 26 MB / ~1 h Hebrew meeting
> (`provider=local-whisper`, `fallbackUsed=false`, coherent transcript +
> accurate summary/action-items).

### Laptop (one-time)

```powershell
# Native Python 3.12 venv (NOT WSL — ctranslate2 needs <=3.12), via uv:
uv venv --python 3.12 C:\meetsum-asr\.venv
C:\meetsum-asr\.venv\Scripts\python.exe -m pip install faster-whisper fastapi "uvicorn[standard]" python-multipart
# Model cache on D: — C: was full; the ivrit CT2 model is ~1.6 GB:
$env:HF_HOME = "D:\meetsum-asr\hf-cache"
# Pre-download the model AS THE LOGGED-IN USER (SYSTEM can't resolve HF):
C:\meetsum-asr\.venv\Scripts\python.exe -c "import os; os.environ['HF_HOME']=r'D:\meetsum-asr\hf-cache'; from faster_whisper import WhisperModel; WhisperModel('ivrit-ai/whisper-large-v3-turbo-ct2', device='cpu', compute_type='int8'); print('READY')"
```

Copy `app.py` (in this folder) to `C:\meetsum-asr\app.py`.

### Auto-start as a SYSTEM service (survives logoff/reboot, binds the tailnet)

```powershell
# Run as SYSTEM at startup so it's up without a login session, model cache on D:
$action = 'cmd /c "set HF_HOME=D:\meetsum-asr\hf-cache&&C:\meetsum-asr\.venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8771 >> D:\meetsum-asr\server.log 2>&1"'
schtasks /Create /TN MeetSumASR-native /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $action /F
# working dir is set by `cmd /c` cd or the task's Start-in; ensure it's C:\meetsum-asr
schtasks /Run /TN MeetSumASR-native
```

### CRITICAL: keep the laptop reachable (these caused real fallbacks)

```powershell
# The laptop went to sleep mid-run and dropped off Tailscale -> Gemini fallback.
# Disable sleep/hibernate/lid-sleep on AC AND battery:
powercfg /change standby-timeout-ac 0 ; powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0 ; powercfg /change hibernate-timeout-dc 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
```

### VPS-side env required for long CPU transcriptions

Set in `/opt/meetsum/.env.local` (then `docker compose ... up -d worker`):

```
LOCAL_TRANSCRIPTION_URL=http://100.119.125.14:8771
LOCAL_TRANSCRIPTION_MODEL=ivrit-ai/whisper-large-v3-turbo-ct2
MEETSUM_TRANSCRIPTION_PROVIDER=auto
LOCAL_TRANSCRIPTION_TIMEOUT_MS=3600000   # 15-min default aborts long CPU runs
```

### Four code/infra fixes that were required (all live on `main`)

These are documented here because the laptop host's behaviour drove them; the
code fixes themselves are in `lib/ai/providers.ts` on `main`:

1. **HTTP 422 "file required"** — the installed `undici` doesn't recognize a
   global `FormData`, so the multipart body serialized empty. Build the request
   with undici's own `FormData` + a `Blob` via `form.set("file", blob, name)`.
2. **`fetch failed` at ~5 min (`ECONNRESET`)** — a stateful firewall/NAT resets
   the **idle** TCP connection while the model transcribes silently. Enable TCP
   keepalive on the undici dispatcher
   (`connect: { keepAlive: true, keepAliveInitialDelay: 30_000 }`).
3. **15-minute abort** — raise `LOCAL_TRANSCRIPTION_TIMEOUT_MS` (CPU `int8` does
   ~26 MB in 16–21 min); the `AbortController` is the real cap once undici's own
   300 s `headersTimeout`/`bodyTimeout` are disabled.
4. **`invalid input syntax for timestamp` ("Friday")** — the summary model
   emits non-date due strings; `coerceDueDate()` in `postgres-repository.ts`
   drops them to `null` instead of crashing the intelligence write.

### Validated transcribe config

See `app.py` in this folder — `condition_on_previous_text=False` + `vad_filter`
+ confidence thresholds eliminated the intro hallucination (the model was
inventing ~15 nonsense Hebrew segments over the first 40 s of music/silence).

---

## Part A — Laptop (Windows + WSL2) — ABANDONED (kept for reference)

> Superseded by the native setup above. Run faster-whisper-server in Docker
> inside WSL2 (or Docker Desktop), then expose its port on the laptop's
> Tailscale IP. Did not survive headless operation or long connections.

### A1. Start the ASR container (in WSL2)

Copy `docker-compose.yml` (in this folder) to the laptop, then:

```bash
# inside WSL2
mkdir -p ~/meetsum-asr && cd ~/meetsum-asr
# copy docker-compose.yml here, then:
docker compose up -d
docker compose logs -f   # wait for "Uvicorn running on http://0.0.0.0:8000"
```

First transcription downloads the ivrit model (~1.6 GB) into the
`hf-cache` volume; subsequent starts are instant. The compose sets
`WHISPER__COMPUTE_TYPE=int8` and preloads the ivrit model.

### A2. Expose port 8771 on the Tailscale IP

WSL2 containers are NAT'd and not reachable from the tailnet by default. Pick
**one** of these (the portproxy option mirrors however Lemonade:13305 is already
exposed):

**Option 1 — Windows portproxy + firewall (most reliable).** In an
**Administrator PowerShell on Windows** run `expose-tailscale.ps1` (in this
folder), or manually:

```powershell
# WSL2 container is reachable on Windows localhost:8771 (Docker Desktop) — bridge
# the Tailscale IP to it, and allow it through the firewall.
netsh interface portproxy add v4tov4 listenaddress=100.119.125.14 listenport=8771 connectaddress=127.0.0.1 connectport=8771
New-NetFirewallRule -DisplayName "MeetSum ASR 8771 (Tailscale)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8771 -RemoteAddress 100.64.0.0/10
```

> If Docker runs *inside* WSL2 (not Docker Desktop), point `connectaddress` at
> the WSL2 IP (`wsl hostname -I`) instead of `127.0.0.1`, or run the container
> with `network_mode: host` in WSL2 and portproxy to the WSL2 IP.

**Option 2 — Tailscale inside WSL2.** Install Tailscale in the WSL2 distro and
`tailscale up`; the container port is then directly on that node's tailnet IP
(use that IP in Part B instead of `100.119.125.14`).

### A3. Verify from the laptop

```bash
curl -s http://localhost:8771/v1/models | head -c 200      # in WSL2
```
And from the VPS (Part B) once exposed.

---

## Part B — VPS (point MeetSum at the laptop)

SSH: `ssh openclaw-vps` (root@37.27.182.247), then `cd /opt/meetsum`.

### B1. Confirm reachability

```bash
curl -s -m 8 http://100.119.125.14:8771/v1/models | head -c 200
# expect a JSON model list. 000/timeout = laptop offline or not exposed (Part A2).
```

### B2. Repoint MeetSum ASR (edit `.env.local`)

```bash
cp .env.local .env.local.bak-$(date +%Y%m%d%H%M%S)
# set (or replace) these keys:
#   LOCAL_TRANSCRIPTION_URL=http://100.119.125.14:8771
#   LOCAL_TRANSCRIPTION_MODEL=ivrit-ai/whisper-large-v3-turbo-ct2
#   MEETSUM_TRANSCRIPTION_PROVIDER=auto
sed -i 's|^LOCAL_TRANSCRIPTION_URL=.*|LOCAL_TRANSCRIPTION_URL=http://100.119.125.14:8771|' .env.local
grep -q '^LOCAL_TRANSCRIPTION_URL=' .env.local || echo 'LOCAL_TRANSCRIPTION_URL=http://100.119.125.14:8771' >> .env.local
```

### B3. Recreate app + worker so they pick up the new URL

```bash
docker compose --env-file .env.local -f docker-compose.prod.yml up -d app worker
```

### B4. (Optional) free VPS RAM — stop the local faster-whisper

Auto mode falls back to **Gemini** (not the VPS container) when the laptop is
unreachable, so the VPS `faster-whisper` is no longer needed once you repoint:

```bash
docker compose --env-file .env.local -f docker-compose.prod.yml --profile local-asr stop faster-whisper
```
(Leave it running if you prefer a local fallback over Gemini for short clips.)

---

## Part C — Validate end to end

1. Process a real Hebrew meeting (or `npm run asr:evaluate -- --manifest .secrets/asr-eval/manifest.json`).
2. Confirm it used the laptop, not Gemini:

```bash
docker compose --env-file .env.local -f docker-compose.prod.yml exec -T postgres \
  psql -U meetings -d meetings -c \
  "select provider, model, metadata->>'fallbackUsed' as fell_back, started_at
   from ai_runs where task='audio.transcribe' order by started_at desc limit 3;"
```
Expect `provider=local-whisper`, `model=ivrit-ai/whisper-large-v3-turbo-ct2`,
`fell_back=false`.

---

## Rollback

```bash
cd /opt/meetsum
cp .env.local.bak-<stamp> .env.local         # or set LOCAL_TRANSCRIPTION_URL back to http://faster-whisper:8000
docker compose --env-file .env.local -f docker-compose.prod.yml --profile local-asr up -d faster-whisper
docker compose --env-file .env.local -f docker-compose.prod.yml up -d app worker
```

## Notes / open items

- **Model name:** `ivrit-ai/whisper-large-v3-turbo-ct2` must be a valid
  faster-whisper (CTranslate2) repo on Hugging Face. If the laptop has no
  internet at runtime, pre-pull it into the `hf-cache` volume first.
- **Keeping it warm:** Docker `restart: unless-stopped` + the preloaded model
  keep the service ready across reboots. The VPS `lemonade-watchdog` does **not**
  manage this service (it manages Lemonade:13305); if you want auto-recovery
  monitoring, add a Tailscale/Uptime-Kuma HTTP monitor on
  `http://100.119.125.14:8771/v1/models`.
- **Tailscale IP** assumed `100.119.125.14` (node `desktop-daaocqf-asus`). If it
  changes, update Part A2 and B2 accordingly.
