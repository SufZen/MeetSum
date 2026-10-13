# MeetSum Hebrew ASR worker: faster-whisper (ivrit-ai) + pyannote diarization,
# RunPod serverless, meetsum-asr/v1. See README.md.
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/hf \
    ASR_MODEL=ivrit-ai/whisper-large-v3-turbo-ct2 \
    DIARIZATION_MODEL=pyannote/speaker-diarization-community-1

RUN apt-get update \
 && apt-get install -y --no-install-recommends software-properties-common ca-certificates curl ffmpeg \
 && add-apt-repository -y ppa:deadsnakes/ppa \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3.11 python3.11-venv python3.11-dev \
 && apt-get purge -y software-properties-common \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

RUN python3.11 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

# Bake the (public) Whisper model into the image so cold starts skip the
# ~1.6 GB download. The gated pyannote model needs HF_TOKEN and is fetched at
# first use into HF_HOME (mount a RunPod network volume at /models to keep it).
RUN python -c "from faster_whisper.utils import download_model; download_model('${ASR_MODEL}')"

COPY schema.py merge.py pipeline.py handler.py ./

CMD ["python", "-u", "handler.py"]
