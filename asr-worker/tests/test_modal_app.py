"""Request/auth helpers of modal_app.py, without the `modal` package or a GPU."""

import base64

import pytest

import modal_app
from schema import SCHEMA, SchemaError


def _input(**overrides):
    value = {
        "schema": SCHEMA,
        "audio": {"type": "blob", "data": base64.b64encode(b"OggS-fake").decode()},
        "model": "ivrit-ai/whisper-large-v3-turbo-ct2",
        "language": "he",
        "diarize": True,
    }
    value.update(overrides)
    return value


class TestBearerAuthorized:
    def test_accepts_the_exact_token(self):
        assert modal_app.bearer_authorized("Bearer s3cret", "s3cret")

    @pytest.mark.parametrize(
        "header",
        [None, "", "s3cret", "Basic s3cret", "Bearer wrong", "Bearer s3cret-extra", "bearer s3cret"],
    )
    def test_rejects_anything_else(self, header):
        assert not modal_app.bearer_authorized(header, "s3cret")

    @pytest.mark.parametrize("expected", [None, ""])
    def test_fails_closed_without_a_configured_token(self, expected):
        assert not modal_app.bearer_authorized("Bearer ", expected)
        assert not modal_app.bearer_authorized("Bearer anything", expected)


class TestValidateSubmission:
    def test_returns_the_meetsum_input(self):
        job_input = _input(min_speakers=2, max_speakers=4)
        assert modal_app.validate_submission({"input": job_input}) == job_input

    def test_accepts_presigned_urls(self):
        job_input = _input(audio={"type": "url", "url": "https://media.example.com/a.ogg?X-Amz-Signature=x"})
        assert modal_app.validate_submission({"input": job_input})["audio"]["type"] == "url"

    @pytest.mark.parametrize(
        "body",
        [
            None,
            [],
            {},
            {"input": None},
            {"input": _input(schema="other/v1")},
            {"input": _input(audio={"type": "file", "path": "/etc/passwd"})},
            {"input": _input(audio={"type": "url", "url": "file:///etc/passwd"})},
            {"input": _input(audio={"type": "blob", "data": "not base64!!"})},
            {"input": _input(min_speakers=5, max_speakers=2)},
        ],
    )
    def test_rejects_malformed_bodies(self, body):
        with pytest.raises(SchemaError):
            modal_app.validate_submission(body)

    def test_enforces_the_blob_limit(self):
        job_input = _input(audio={"type": "blob", "data": base64.b64encode(b"x" * 300).decode()})
        with pytest.raises(SchemaError, match="too large"):
            modal_app.validate_submission({"input": job_input}, max_blob_bytes=100)


class TestCallIds:
    @pytest.mark.parametrize("call_id", ["fc-01ABCdef", "fc-1"])
    def test_accepts_modal_function_call_ids(self, call_id):
        assert modal_app.valid_call_id(call_id)

    @pytest.mark.parametrize("call_id", ["", "fc-", "../health", "fc-abc/def", "ta-123", "fc-" + "a" * 65])
    def test_rejects_other_ids(self, call_id):
        assert not modal_app.valid_call_id(call_id)


class TestJobResultPayload:
    def test_completed_output_with_execution_time(self):
        output = {"schema": SCHEMA, "words": []}
        assert modal_app.job_result_payload("fc-1", {"output": output, "execution_ms": 1234}) == {
            "id": "fc-1",
            "status": "COMPLETED",
            "output": output,
            "executionTime": 1234,
        }

    def test_worker_errors_become_failed_and_keep_the_bad_media_marker(self):
        payload = modal_app.job_result_payload(
            "fc-1",
            {"output": {"error": "[bad_media] cannot decode", "error_kind": "bad_media"}, "execution_ms": 50},
        )
        assert payload == {
            "id": "fc-1",
            "status": "FAILED",
            "error": "[bad_media] cannot decode",
            "error_kind": "bad_media",
            "executionTime": 50,
        }

    def test_plain_worker_errors_have_no_error_kind(self):
        payload = modal_app.job_result_payload("fc-1", {"output": {"error": "Worker error: boom"}})
        assert payload["status"] == "FAILED"
        assert "error_kind" not in payload
        assert payload["executionTime"] == 0


def test_run_timed_wraps_the_handler_and_measures_time():
    calls = []

    def runner(job):
        calls.append(job)
        return {"schema": SCHEMA, "words": []}

    result = modal_app.run_timed(_input(), runner=runner)
    assert calls == [{"input": _input()}]
    assert result["output"] == {"schema": SCHEMA, "words": []}
    assert isinstance(result["execution_ms"], int) and result["execution_ms"] >= 0
