# MeetSum Hebrew ASR server (ivrit-ai, CPU/int8) — VALIDATED.
#
# Native FastAPI + faster-whisper. Exposes an OpenAI-compatible
# /v1/audio/transcriptions endpoint that the MeetSum worker POSTs audio to.
# Runs on the Ryzen AI MAX laptop under a SYSTEM scheduled task (see README).
#
# Deploy: scp this to C:\meetsum-asr\app.py and run under the venv:
#   set HF_HOME=D:\meetsum-asr\hf-cache
#   C:\meetsum-asr\.venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8771
import os
os.environ.setdefault("HF_HOME", r"C:\meetsum-asr\hf-cache")
import tempfile
from typing import List, Optional

from fastapi import FastAPI, UploadFile, File, Form
from faster_whisper import WhisperModel

MODEL = os.environ.get("ASR_MODEL", "ivrit-ai/whisper-large-v3-turbo-ct2")
COMPUTE = os.environ.get("ASR_COMPUTE", "int8")
_model = WhisperModel(MODEL, device="cpu", compute_type=COMPUTE)
app = FastAPI()


@app.get("/v1/models")
def models():
    return {"data": [{"id": MODEL, "object": "model"}]}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(None),
    language: str = Form(None),
    response_format: str = Form("json"),
    # MeetSum (lib/ai/asr/providers/local-whisper-chunked.ts) sends these:
    #   hotwords                   glossary terms, Latin first (faster-whisper hotwords)
    #   prompt                     optional initial prompt (MEETSUM_ASR_USE_INITIAL_PROMPT)
    #   timestamp_granularities[]  "word" -> per-word timings (OpenAI verbose_json shape)
    hotwords: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
    timestamp_granularities: Optional[List[str]] = Form(None, alias="timestamp_granularities[]"),
):
    suffix = os.path.splitext(file.filename or "audio")[1] or ".bin"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        path = tmp.name
    want_words = "word" in (timestamp_granularities or [])
    try:
        # Anti-hallucination config (VALIDATED on a real 26 MB Hebrew meeting).
        # Whisper invents text over intro music / silence and, with the default
        # condition_on_previous_text=True, feeds that garbage forward into later
        # windows (we observed ~15 nonsense segments filling the first 40s).
        # Disabling it + VAD filtering + confidence thresholds keeps the
        # transcript anchored to real speech. MeetSum sends <=10 min chunks.
        segments, info = _model.transcribe(
            path,
            language=(language or None),
            beam_size=5,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4,
            word_timestamps=want_words,
            hotwords=(hotwords or None),
            initial_prompt=(prompt or None),
        )
        segs, texts, words = [], [], []
        for i, s in enumerate(segments):
            seg = {"id": i, "start": s.start, "end": s.end, "text": s.text}
            if want_words and s.words:
                seg_words = [
                    {"word": w.word, "start": w.start, "end": w.end, "probability": w.probability}
                    for w in s.words
                ]
                seg["words"] = seg_words
                words.extend(seg_words)
            segs.append(seg)
            texts.append(s.text)
        body = {
            "text": "".join(texts).strip(),
            "segments": segs,
            "language": info.language,
            "duration": info.duration,
        }
        if want_words:
            body["words"] = words
        return body
    finally:
        os.unlink(path)
