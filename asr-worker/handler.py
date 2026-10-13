"""RunPod serverless entry point for the MeetSum ASR worker (meetsum-asr/v1).

Returning ``{"error": ...}`` marks the RunPod job FAILED. Only ffmpeg decode
failures carry ``error_kind: "bad_media"`` (and a ``[bad_media]`` message
prefix, in case RunPod keeps only the error string); MeetSum maps exactly
that marker to a permanent ``bad_input`` and everything else to a
retryable error so its next provider can try
(lib/ai/asr/providers/runpod-ivrit.ts).
"""

from __future__ import annotations

import os
import traceback
from typing import Any, Dict

from schema import SchemaError, parse_job_input

BAD_MEDIA = "bad_media"
BAD_MEDIA_PREFIX = f"[{BAD_MEDIA}]"


def handler(job: Dict[str, Any]) -> Dict[str, Any]:
    try:
        spec = parse_job_input(job.get("input"), max_blob_bytes=int(os.environ.get("MAX_BLOB_BYTES", "50000000")))
    except SchemaError as error:
        return {"error": f"Invalid input (could not read request): {error}"}

    # Imported here so a schema error never pays the CUDA/model import cost.
    from pipeline import JobRejected, MediaDecodeError, MediaError, run_job

    try:
        return run_job(spec)
    except MediaDecodeError as error:
        return {"error": f"{BAD_MEDIA_PREFIX} {error}", "error_kind": BAD_MEDIA}
    except JobRejected as error:
        return {"error": f"Rejected: {error}"}
    except MediaError as error:
        return {"error": str(error)}
    except Exception as error:  # surfaced to MeetSum as a retryable worker error
        traceback.print_exc()
        return {"error": f"Worker error: {type(error).__name__}: {str(error)[:500]}"}


if __name__ == "__main__":
    import runpod

    runpod.serverless.start({"handler": handler})
