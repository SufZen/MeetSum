"""Modal deployment of the MeetSum ASR worker (meetsum-asr/v1).

Runs the same pipeline as the RunPod image (ivrit-ai faster-whisper turbo +
pyannote diarization, ``handler.py``) on a serverless Modal GPU, which fits
Modal's free monthly compute credit for small workloads. MeetSum talks to it
through ``lib/ai/asr/providers/modal-worker.ts`` (``MODAL_ASR_URL`` +
``MODAL_ASR_TOKEN``).

Modal caps a synchronous web request at ~150 s, so the API is submit/poll::

    POST /v1/jobs              {"input": <meetsum-asr/v1 input>} -> {"id", "status": "IN_QUEUE"}
    GET  /v1/jobs/{id}         -> {"id", "status", "output"?, "error"?, "error_kind"?, "executionTime"?}
    POST /v1/jobs/{id}/cancel  -> {"id", "status": "CANCELLED"}
    GET  /health               -> {"ok": true, "gpu", "model"}   (CPU only, no GPU start)

Every route needs ``Authorization: Bearer <MEETSUM_ASR_TOKEN>`` (the token
lives in the ``meetsum-asr-auth`` Modal Secret; requests are rejected when
it is unset). The gated pyannote model needs ``HF_TOKEN`` from the
``huggingface`` Modal Secret. Models are cached in the
``meetsum-asr-models`` Volume so only the first cold start downloads them.

Deploy (from this directory)::

    modal secret create huggingface HF_TOKEN=hf_...
    modal secret create meetsum-asr-auth MEETSUM_ASR_TOKEN=$(openssl rand -hex 32)
    modal deploy modal_app.py

The request/auth helpers below are pure Python and importable without the
``modal`` package (asr-worker/tests/test_modal_app.py).
"""

from __future__ import annotations

import hmac
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, Optional

from schema import SchemaError, parse_job_input

APP_NAME = os.environ.get("MODAL_APP_NAME", "meetsum-asr")
GPU = os.environ.get("MODAL_ASR_GPU", "T4")  # "L4" is ~35% pricier and faster
MODEL_VOLUME = "meetsum-asr-models"
AUTH_SECRET = "meetsum-asr-auth"
HF_SECRET = "huggingface"
MODELS_DIR = "/models"
ASR_MODEL = os.environ.get("ASR_MODEL", "ivrit-ai/whisper-large-v3-turbo-ct2")
# Keep a warm container briefly after a job (billed while idle).
SCALEDOWN_WINDOW_S = int(os.environ.get("MODAL_SCALEDOWN_WINDOW_S", "120"))
JOB_TIMEOUT_S = int(os.environ.get("MODAL_JOB_TIMEOUT_S", "3600"))
MAX_BLOB_BYTES = int(os.environ.get("MAX_BLOB_BYTES", "50000000"))

CALL_ID = re.compile(r"^fc-[A-Za-z0-9]{1,64}$")


# ---------------------------------------------------------------------------
# Pure helpers (tested without Modal)
# ---------------------------------------------------------------------------


def bearer_authorized(authorization: Optional[str], expected: Optional[str]) -> bool:
    """Constant-time bearer check. Fails closed when no token is configured."""
    if not expected:
        return False
    if not authorization or not authorization.startswith("Bearer "):
        return False
    supplied = authorization[len("Bearer ") :].strip()
    return hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))


def validate_submission(body: Any, max_blob_bytes: int = MAX_BLOB_BYTES) -> Dict[str, Any]:
    """Returns the ``meetsum-asr/v1`` input of a submit body, or raises SchemaError.

    Validates with the worker's own parser before spawning a GPU job, so a
    malformed request costs no GPU time.
    """
    if not isinstance(body, dict):
        raise SchemaError("body must be an object")
    job_input = body.get("input")
    parse_job_input(job_input, max_blob_bytes=max_blob_bytes)
    return job_input  # type: ignore[return-value]


def valid_call_id(call_id: str) -> bool:
    return bool(CALL_ID.match(call_id or ""))


def job_result_payload(call_id: str, result: Dict[str, Any]) -> Dict[str, Any]:
    """Maps a worker result (``{"output", "execution_ms"}``) to the poll response."""
    output = result.get("output") or {}
    execution_ms = int(result.get("execution_ms") or 0)
    if isinstance(output, dict) and output.get("error"):
        payload: Dict[str, Any] = {
            "id": call_id,
            "status": "FAILED",
            "error": str(output["error"]),
            "executionTime": execution_ms,
        }
        if output.get("error_kind"):
            payload["error_kind"] = output["error_kind"]
        return payload
    return {"id": call_id, "status": "COMPLETED", "output": output, "executionTime": execution_ms}


def run_timed(job_input: Dict[str, Any], runner=None) -> Dict[str, Any]:
    """Runs ``handler.handler`` and measures GPU execution time (billing basis)."""
    if runner is None:
        from handler import handler as runner  # noqa: WPS433 (lazy: heavy imports)
    started = time.monotonic()
    output = runner({"input": job_input})
    return {"output": output, "execution_ms": int((time.monotonic() - started) * 1000)}


# ---------------------------------------------------------------------------
# Modal app (only defined when the `modal` package is installed)
# ---------------------------------------------------------------------------

try:  # pragma: no cover - exercised only under `modal deploy` / `modal serve`
    import modal
except ImportError:  # pragma: no cover
    modal = None  # type: ignore[assignment]

if modal is not None:  # pragma: no cover
    HERE = Path(__file__).resolve().parent
    WORKER_FILES = ("schema.py", "merge.py", "pipeline.py", "handler.py", "modal_app.py")

    def _with_sources(image):
        for name in WORKER_FILES:
            image = image.add_local_file(HERE / name, f"/root/{name}")
        return image

    gpu_image = _with_sources(
        modal.Image.from_registry("nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04", add_python="3.11")
        .apt_install("ffmpeg")
        .pip_install_from_requirements(str(HERE / "requirements.txt"))
        .env({"HF_HOME": f"{MODELS_DIR}/hf", "ASR_MODEL": ASR_MODEL, "PYTHONUNBUFFERED": "1"})
    )
    web_image = _with_sources(modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]==0.115.*"))

    app = modal.App(APP_NAME)
    models = modal.Volume.from_name(MODEL_VOLUME, create_if_missing=True)

    @app.cls(
        image=gpu_image,
        gpu=GPU,
        volumes={MODELS_DIR: models},
        secrets=[modal.Secret.from_name(HF_SECRET)],
        timeout=JOB_TIMEOUT_S,
        scaledown_window=SCALEDOWN_WINDOW_S,
        max_containers=int(os.environ.get("MODAL_MAX_CONTAINERS", "2")),
    )
    class AsrWorker:
        @modal.enter()
        def warm(self) -> None:
            # Download (first run) or load the Whisper model from the Volume,
            # then persist anything new so later cold starts skip the download.
            from faster_whisper.utils import download_model

            download_model(ASR_MODEL)
            models.commit()

        @modal.method()
        def run(self, job_input: Dict[str, Any]) -> Dict[str, Any]:
            result = run_timed(job_input)
            models.commit()  # pyannote is fetched lazily on the first diarized job
            return result

    @app.function(image=web_image, secrets=[modal.Secret.from_name(AUTH_SECRET)])
    @modal.asgi_app()
    def web():
        from fastapi import FastAPI, Request
        from fastapi.responses import JSONResponse

        api = FastAPI(title="MeetSum ASR", docs_url=None, redoc_url=None, openapi_url=None)

        def deny(request: Request) -> Optional[JSONResponse]:
            if bearer_authorized(request.headers.get("authorization"), os.environ.get("MEETSUM_ASR_TOKEN")):
                return None
            return JSONResponse({"error": "unauthorized"}, status_code=401)

        @api.get("/health")
        async def health(request: Request):
            return deny(request) or {"ok": True, "gpu": GPU, "model": ASR_MODEL}

        @api.post("/v1/jobs")
        async def submit(request: Request):
            denied = deny(request)
            if denied:
                return denied
            try:
                job_input = validate_submission(await request.json())
            except SchemaError as error:
                return JSONResponse({"error": f"Invalid input (could not read request): {error}"}, status_code=400)
            except ValueError:
                return JSONResponse({"error": "Invalid input (could not read request): body is not JSON"}, status_code=400)
            call = await AsrWorker().run.spawn.aio(job_input)
            return {"id": call.object_id, "status": "IN_QUEUE"}

        @api.get("/v1/jobs/{call_id}")
        async def status(call_id: str, request: Request):
            denied = deny(request)
            if denied:
                return denied
            if not valid_call_id(call_id):
                return JSONResponse({"error": "unknown job"}, status_code=404)
            call = modal.FunctionCall.from_id(call_id)
            try:
                result = await call.get.aio(timeout=0)
            except (TimeoutError, modal.exception.TimeoutError):
                return {"id": call_id, "status": "IN_PROGRESS"}
            except modal.exception.OutputExpiredError:
                return JSONResponse({"error": "job result expired"}, status_code=404)
            except Exception as error:  # crashed / cancelled container
                return {"id": call_id, "status": "FAILED", "error": f"Worker error: {type(error).__name__}: {str(error)[:300]}"}
            return job_result_payload(call_id, result)

        @api.post("/v1/jobs/{call_id}/cancel")
        async def cancel(call_id: str, request: Request):
            denied = deny(request)
            if denied:
                return denied
            if not valid_call_id(call_id):
                return JSONResponse({"error": "unknown job"}, status_code=404)
            await modal.FunctionCall.from_id(call_id).cancel.aio()
            return {"id": call_id, "status": "CANCELLED"}

        return api
