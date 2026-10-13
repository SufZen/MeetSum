"""meetsum-asr/v1 input/output schema (mirrors lib/ai/asr/providers/runpod-ivrit.ts).

Input (``job["input"]``)::

    {
      "schema": "meetsum-asr/v1",
      "audio": {"type": "url", "url": "https://..."} | {"type": "blob", "data": "<base64>"},
      "model": "ivrit-ai/whisper-large-v3-turbo-ct2",
      "language": "he" | null,          # null -> auto-detect
      "diarize": true,
      "min_speakers": 2, "max_speakers": 6,   # optional
      "hotwords": "Supabase, Gemini",          # optional
      "initial_prompt": "...",                 # optional
      "word_timestamps": true
    }

Output::

    {
      "schema": "meetsum-asr/v1",
      "model": str, "language": str, "duration_s": float,
      "diarization": "provider" | "none",
      "words": [{"start": s, "end": s, "text": str, "confidence": float|null, "speaker": str|null}],
      "speakers": [{"label": str, "embedding": [float]|null}],
      "embedding_model": str|null,
      "timings": {"download_ms": int, ...},
      "warnings": [str]
    }

Pure Python: importable without GPU dependencies.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

SCHEMA = "meetsum-asr/v1"
DEFAULT_MODEL = "ivrit-ai/whisper-large-v3-turbo-ct2"
MAX_HOTWORDS_CHARS = 2000
MAX_PROMPT_CHARS = 1000


class SchemaError(ValueError):
    """The job input is malformed (maps to a non-retryable bad request)."""


@dataclass
class AudioSource:
    type: str
    url: Optional[str] = None
    data: Optional[bytes] = None


@dataclass
class AsrJob:
    audio: AudioSource
    model: str = DEFAULT_MODEL
    language: Optional[str] = "he"
    diarize: bool = True
    min_speakers: Optional[int] = None
    max_speakers: Optional[int] = None
    hotwords: Optional[str] = None
    initial_prompt: Optional[str] = None
    word_timestamps: bool = True
    warnings: List[str] = field(default_factory=list)


def _optional_int(raw: Dict[str, Any], key: str) -> Optional[int]:
    value = raw.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > 32:
        raise SchemaError(f"{key} must be an integer between 1 and 32")
    return value


def _optional_text(raw: Dict[str, Any], key: str, limit: int) -> Optional[str]:
    value = raw.get(key)
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise SchemaError(f"{key} must be a string")
    return value[:limit]


def parse_job_input(raw: Any, max_blob_bytes: int = 50_000_000) -> AsrJob:
    if not isinstance(raw, dict):
        raise SchemaError("input must be an object")
    if raw.get("schema") != SCHEMA:
        raise SchemaError(f"input.schema must be {SCHEMA!r}")

    audio = raw.get("audio")
    if not isinstance(audio, dict):
        raise SchemaError("input.audio must be an object")
    if audio.get("type") == "url":
        url = audio.get("url")
        if not isinstance(url, str) or not url.startswith(("https://", "http://")):
            raise SchemaError("input.audio.url must be an http(s) URL")
        source = AudioSource(type="url", url=url)
    elif audio.get("type") == "blob":
        data = audio.get("data")
        if not isinstance(data, str) or not data:
            raise SchemaError("input.audio.data must be base64 text")
        if len(data) * 3 // 4 > max_blob_bytes:
            raise SchemaError("input.audio.data is too large")
        try:
            decoded = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError) as error:
            raise SchemaError(f"input.audio.data is not valid base64: {error}") from error
        source = AudioSource(type="blob", data=decoded)
    else:
        raise SchemaError("input.audio.type must be 'url' or 'blob'")

    model = raw.get("model") or DEFAULT_MODEL
    if not isinstance(model, str):
        raise SchemaError("input.model must be a string")

    language = raw.get("language", "he")
    if language is not None and (not isinstance(language, str) or not 2 <= len(language) <= 8):
        raise SchemaError("input.language must be a language code or null")

    min_speakers = _optional_int(raw, "min_speakers")
    max_speakers = _optional_int(raw, "max_speakers")
    if min_speakers and max_speakers and min_speakers > max_speakers:
        raise SchemaError("min_speakers must be <= max_speakers")

    return AsrJob(
        audio=source,
        model=model,
        language=language or None,
        diarize=bool(raw.get("diarize", True)),
        min_speakers=min_speakers,
        max_speakers=max_speakers,
        hotwords=_optional_text(raw, "hotwords", MAX_HOTWORDS_CHARS),
        initial_prompt=_optional_text(raw, "initial_prompt", MAX_PROMPT_CHARS),
        word_timestamps=bool(raw.get("word_timestamps", True)),
    )


def _round(value: Optional[float], digits: int = 3) -> Optional[float]:
    return None if value is None else round(float(value), digits)


def build_output(
    *,
    model: str,
    language: str,
    duration_s: float,
    words: List[Dict[str, Any]],
    diarization: str,
    speakers: Optional[List[Dict[str, Any]]] = None,
    embedding_model: Optional[str] = None,
    timings: Optional[Dict[str, int]] = None,
    warnings: Optional[List[str]] = None,
) -> Dict[str, Any]:
    return {
        "schema": SCHEMA,
        "model": model,
        "language": language,
        "duration_s": _round(duration_s),
        "diarization": diarization if diarization in ("provider", "none") else "none",
        "words": [
            {
                "start": _round(word.get("start")) or 0.0,
                "end": _round(word.get("end")) or _round(word.get("start")) or 0.0,
                "text": str(word.get("text", "")).strip(),
                "confidence": _round(word.get("confidence")),
                "speaker": word.get("speaker"),
            }
            for word in words
            if str(word.get("text", "")).strip()
        ],
        "speakers": [
            {
                "label": str(speaker["label"]),
                "embedding": [round(float(x), 5) for x in speaker["embedding"]]
                if speaker.get("embedding") is not None
                else None,
            }
            for speaker in (speakers or [])
        ],
        "embedding_model": embedding_model,
        "timings": dict(timings or {}),
        "warnings": list(warnings or []),
    }
