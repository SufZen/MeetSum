"""MeetSum ASR pipeline: download -> 16 kHz WAV -> faster-whisper -> pyannote -> merge.

Heavy dependencies (faster_whisper, pyannote.audio, torch, numpy) are
imported lazily so schema/merge stay importable (and testable) without a
GPU. Models are loaded once per worker and cached between jobs.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
import wave
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urlsplit

from merge import assign_speakers
from schema import AsrJob, build_output

ASR_MODEL = os.environ.get("ASR_MODEL", "ivrit-ai/whisper-large-v3-turbo-ct2")
# Model MeetSum requests for non-Hebrew meetings (RUNPOD_ASR_MODEL_MULTILINGUAL).
ASR_MODEL_MULTILINGUAL = os.environ.get("ASR_MODEL_MULTILINGUAL", "large-v3-turbo")
# ffmpeg may only read local files/pipes (no http, hls, concat tricks).
FFMPEG_INPUT_PROTOCOLS = ["-protocol_whitelist", "file,pipe"]
DIARIZATION_MODEL = os.environ.get("DIARIZATION_MODEL", "pyannote/speaker-diarization-community-1")
MAX_AUDIO_BYTES = int(os.environ.get("MAX_AUDIO_BYTES", str(1024 * 1024 * 1024)))
DOWNLOAD_TIMEOUT_S = int(os.environ.get("DOWNLOAD_TIMEOUT_S", "300"))
COMPUTE_TYPE = os.environ.get("ASR_COMPUTE_TYPE", "float16")
FFMPEG_TIMEOUT_S = int(os.environ.get("FFMPEG_TIMEOUT_S", "1800"))

_whisper_models: Dict[str, Any] = {}
_diarization_pipeline: Any = None


class MediaError(RuntimeError):
    """The audio could not be fetched (or is too large) for this job."""


class MediaDecodeError(MediaError):
    """ffmpeg could not decode the audio. The only error MeetSum treats as
    permanent `bad_input` (handler.py adds `error_kind: "bad_media"`)."""


class JobRejected(RuntimeError):
    """The job asks for something this worker does not allow (URL, model)."""


def _env_list(name: str) -> List[str]:
    return [item.strip() for item in os.environ.get(name, "").split(",") if item.strip()]


def allowed_models() -> Set[str]:
    """`ASR_ALLOWED_MODELS` (comma-separated), default ASR_MODEL + the multilingual model."""
    configured = _env_list("ASR_ALLOWED_MODELS")
    if configured:
        return set(configured)
    return {os.environ.get("ASR_MODEL", ASR_MODEL), os.environ.get("ASR_MODEL_MULTILINGUAL", ASR_MODEL_MULTILINGUAL)}


def resolve_model(requested: Optional[str]) -> str:
    model = requested or os.environ.get("ASR_MODEL", ASR_MODEL)
    if model not in allowed_models():
        raise JobRejected(f"Model {model!r} is not allowed (set ASR_ALLOWED_MODELS)")
    return model


def validate_audio_url(url: str) -> str:
    """https only; when `ASR_ALLOWED_AUDIO_HOSTS` is set the host must be listed
    (exact match, or a suffix match for entries starting with ".")."""
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise JobRejected("Audio URL must use https")
    host = parts.hostname.lower()
    allowed = [entry.lower() for entry in _env_list("ASR_ALLOWED_AUDIO_HOSTS")]
    if allowed and not any(host == entry or (entry.startswith(".") and host.endswith(entry)) for entry in allowed):
        raise JobRejected(f"Audio host {host!r} is not in ASR_ALLOWED_AUDIO_HOSTS")
    return url


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------


def download_audio(url: str, destination: str, max_bytes: int = MAX_AUDIO_BYTES) -> int:
    import requests  # lazy: keeps tests dependency-free

    validate_audio_url(url)
    total = 0
    # Redirects are not followed: a presigned URL never redirects, and
    # following one could reach hosts outside the allowlist.
    with requests.get(url, stream=True, timeout=(15, DOWNLOAD_TIMEOUT_S), allow_redirects=False) as response:
        if 300 <= response.status_code < 400:
            raise MediaError(f"Failed to download audio: redirect (HTTP {response.status_code}) not followed")
        if response.status_code >= 400:
            raise MediaError(f"Failed to download audio: HTTP {response.status_code}")
        length = response.headers.get("content-length")
        if length and int(length) > max_bytes:
            raise MediaError(f"Audio is {length} bytes, above MAX_AUDIO_BYTES ({max_bytes})")
        with open(destination, "wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > max_bytes:
                    raise MediaError(f"Audio exceeds MAX_AUDIO_BYTES ({max_bytes})")
                handle.write(chunk)
    if total == 0:
        raise MediaError("Failed to download audio: empty body")
    return total


def to_wav16k(source: str, destination: str) -> None:
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-y", *FFMPEG_INPUT_PROTOCOLS, "-i", source, "-vn", "-ac", "1",
             "-ar", "16000", "-c:a", "pcm_s16le", destination],
            check=True,
            capture_output=True,
            timeout=FFMPEG_TIMEOUT_S,
        )
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or b"").decode("utf-8", "replace")[-400:]
        raise MediaDecodeError(f"Failed to decode audio with ffmpeg: {detail}") from error


def wav_duration_s(path: str) -> float:
    with wave.open(path, "rb") as handle:
        return handle.getnframes() / float(handle.getframerate() or 16000)


def load_waveform(path: str):
    """16-bit mono WAV -> (torch tensor [1, n], sample_rate) without torchcodec."""
    import numpy as np
    import torch

    with wave.open(path, "rb") as handle:
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    return torch.from_numpy(samples).unsqueeze(0), rate


# ---------------------------------------------------------------------------
# ASR
# ---------------------------------------------------------------------------


def get_whisper(model_name: str):
    from faster_whisper import WhisperModel

    if model_name not in _whisper_models:
        if len(_whisper_models) >= 2:
            _whisper_models.pop(next(iter(_whisper_models)))
        _whisper_models[model_name] = WhisperModel(model_name, device="cuda", compute_type=COMPUTE_TYPE)
    return _whisper_models[model_name]


def transcribe(wav_path: str, job: AsrJob) -> Tuple[List[Dict[str, Any]], str]:
    model = get_whisper(resolve_model(job.model))
    # Anti-hallucination settings validated on real Hebrew meetings (see
    # docs/runbooks/laptop-hebrew-asr/app.py): no conditioning on previous
    # text, VAD, and confidence thresholds.
    segments, info = model.transcribe(
        wav_path,
        language=job.language,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
        condition_on_previous_text=False,
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
        hotwords=job.hotwords,
        initial_prompt=job.initial_prompt,
    )
    words: List[Dict[str, Any]] = []
    for segment in segments:
        for word in segment.words or []:
            text = (word.word or "").strip()
            if text:
                words.append({"start": word.start, "end": word.end, "text": text, "confidence": word.probability})
    return words, info.language or (job.language or "he")


# ---------------------------------------------------------------------------
# Diarization
# ---------------------------------------------------------------------------


def get_diarization_pipeline():
    global _diarization_pipeline
    if _diarization_pipeline is None:
        import torch
        from pyannote.audio import Pipeline

        token = os.environ.get("HF_TOKEN")
        if not token:
            raise RuntimeError("HF_TOKEN is required to load the pyannote diarization model")
        pipeline = Pipeline.from_pretrained(DIARIZATION_MODEL, token=token)
        pipeline.to(torch.device("cuda"))
        _diarization_pipeline = pipeline
    return _diarization_pipeline


def _annotation_turns(annotation) -> List[Dict[str, Any]]:
    return [
        {"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker)}
        for turn, _, speaker in annotation.itertracks(yield_label=True)
    ]


def diarize(wav_path: str, job: AsrJob) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Exclusive (one speaker at a time) turns + per-speaker embeddings."""
    pipeline = get_diarization_pipeline()
    waveform, rate = load_waveform(wav_path)
    options: Dict[str, Any] = {}
    if job.min_speakers:
        options["min_speakers"] = job.min_speakers
    if job.max_speakers:
        options["max_speakers"] = job.max_speakers

    output = pipeline({"waveform": waveform, "sample_rate": rate}, **options)
    # pyannote.audio 4: DiarizeOutput(speaker_diarization, exclusive_speaker_diarization, speaker_embeddings)
    regular = getattr(output, "speaker_diarization", output)
    exclusive = getattr(output, "exclusive_speaker_diarization", None) or regular
    turns = _annotation_turns(exclusive)

    speakers: List[Dict[str, Any]] = []
    embeddings = getattr(output, "speaker_embeddings", None)
    labels = list(regular.labels()) if hasattr(regular, "labels") else sorted({t["speaker"] for t in turns})
    for index, label in enumerate(labels):
        vector: Optional[List[float]] = None
        if embeddings is not None and index < len(embeddings):
            vector = [float(x) for x in embeddings[index]]
        speakers.append({"label": str(label), "embedding": vector})
    return turns, speakers


# ---------------------------------------------------------------------------
# Job
# ---------------------------------------------------------------------------


def run_job(job: AsrJob) -> Dict[str, Any]:
    timings: Dict[str, int] = {}
    warnings: List[str] = list(job.warnings)
    # Policy checks before any download or GPU work.
    job.model = resolve_model(job.model)
    if job.audio.type == "url":
        validate_audio_url(job.audio.url or "")
    with tempfile.TemporaryDirectory(prefix="meetsum-asr-") as workdir:
        source = os.path.join(workdir, "input.media")
        wav = os.path.join(workdir, "audio.wav")

        started = time.monotonic()
        if job.audio.type == "url":
            download_audio(job.audio.url or "", source)
        else:
            data = job.audio.data or b""
            if len(data) > MAX_AUDIO_BYTES:
                raise MediaError(f"Audio exceeds MAX_AUDIO_BYTES ({MAX_AUDIO_BYTES})")
            with open(source, "wb") as handle:
                handle.write(data)
        timings["download_ms"] = _ms(started)

        started = time.monotonic()
        to_wav16k(source, wav)
        duration = wav_duration_s(wav)
        timings["decode_ms"] = _ms(started)

        started = time.monotonic()
        words, language = transcribe(wav, job)
        timings["asr_ms"] = _ms(started)

        speakers: List[Dict[str, Any]] = []
        diarization = "none"
        if job.diarize and words:
            started = time.monotonic()
            try:
                turns, speakers = diarize(wav, job)
                words = assign_speakers(words, turns)
                diarization = "provider" if turns else "none"
            except Exception as error:  # diarization failure must not lose the transcript
                warnings.append(f"diarization_failed: {str(error)[:200]}")
            timings["diarization_ms"] = _ms(started)

        return build_output(
            model=job.model,
            language=language,
            duration_s=duration,
            words=words,
            diarization=diarization,
            speakers=speakers,
            embedding_model=DIARIZATION_MODEL if any(s.get("embedding") for s in speakers) else None,
            timings=timings,
            warnings=warnings,
        )
