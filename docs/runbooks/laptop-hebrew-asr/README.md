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

## Part A — Laptop (Windows + WSL2)

Run faster-whisper-server in Docker inside WSL2 (or Docker Desktop), then expose
its port on the laptop's Tailscale IP.

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
