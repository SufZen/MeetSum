"""Pipeline policy + handler error mapping. Pure Python: requests, ffmpeg and
the GPU models are faked, nothing touches the network."""

import subprocess
import sys
import types

import pytest

import handler
import pipeline
from pipeline import (
    JobRejected,
    MediaDecodeError,
    MediaError,
    allowed_models,
    download_audio,
    resolve_model,
    to_wav16k,
    validate_audio_url,
)
from schema import SCHEMA


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ("ASR_ALLOWED_MODELS", "ASR_ALLOWED_AUDIO_HOSTS", "ASR_MODEL", "ASR_MODEL_MULTILINGUAL"):
        monkeypatch.delenv(name, raising=False)


class FakeResponse:
    def __init__(self, status_code=200, body=b"audio", headers=None):
        self.status_code = status_code
        self.headers = headers or {}
        self._body = body

    def iter_content(self, chunk_size):
        yield self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def fake_requests(monkeypatch):
    calls = []
    state = {"response": FakeResponse()}

    def get(url, **kwargs):
        calls.append((url, kwargs))
        return state["response"]

    monkeypatch.setitem(sys.modules, "requests", types.SimpleNamespace(get=get))
    return calls, state


class TestAudioUrlPolicy:
    def test_requires_https(self):
        with pytest.raises(JobRejected):
            validate_audio_url("http://media.example.com/a.ogg")
        with pytest.raises(JobRejected):
            validate_audio_url("file:///etc/passwd")
        assert validate_audio_url("https://media.example.com/a.ogg?sig=1")

    def test_optional_host_allowlist(self, monkeypatch):
        monkeypatch.setenv("ASR_ALLOWED_AUDIO_HOSTS", "media.example.com, .r2.example.net")
        assert validate_audio_url("https://media.example.com/a.ogg")
        assert validate_audio_url("https://bucket.r2.example.net/a.ogg")
        with pytest.raises(JobRejected):
            validate_audio_url("https://169.254.169.254/latest/meta-data")
        with pytest.raises(JobRejected):
            validate_audio_url("https://evilmedia.example.com/a.ogg")

    def test_download_never_follows_redirects(self, fake_requests, tmp_path):
        calls, state = fake_requests
        destination = str(tmp_path / "in.media")

        assert download_audio("https://media.example.com/a.ogg", destination) == len(b"audio")
        assert calls[0][1]["allow_redirects"] is False

        state["response"] = FakeResponse(status_code=302, headers={"location": "http://169.254.169.254/"})
        with pytest.raises(MediaError) as caught:
            download_audio("https://media.example.com/a.ogg", destination)
        assert not isinstance(caught.value, MediaDecodeError)

    def test_download_rejects_http_before_any_request(self, fake_requests, tmp_path):
        calls, _ = fake_requests
        with pytest.raises(JobRejected):
            download_audio("http://media.example.com/a.ogg", str(tmp_path / "in.media"))
        assert calls == []


class TestModelPolicy:
    def test_defaults_to_configured_and_multilingual_models(self, monkeypatch):
        monkeypatch.setenv("ASR_MODEL", "ivrit-ai/whisper-large-v3-turbo-ct2")
        assert allowed_models() == {"ivrit-ai/whisper-large-v3-turbo-ct2", "large-v3-turbo"}
        assert resolve_model(None) == "ivrit-ai/whisper-large-v3-turbo-ct2"
        assert resolve_model("large-v3-turbo") == "large-v3-turbo"
        with pytest.raises(JobRejected):
            resolve_model("someone/huge-untrusted-model")

    def test_env_allowlist(self, monkeypatch):
        monkeypatch.setenv("ASR_ALLOWED_MODELS", "a/one, b/two")
        assert resolve_model("b/two") == "b/two"
        with pytest.raises(JobRejected):
            resolve_model("large-v3-turbo")


class TestFfmpeg:
    def test_whitelists_protocols_and_marks_decode_failures(self, monkeypatch):
        seen = []

        def fake_run(args, **kwargs):
            seen.append(args)
            raise subprocess.CalledProcessError(1, args, stderr=b"Invalid data found when processing input")

        monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
        with pytest.raises(MediaDecodeError):
            to_wav16k("in.media", "out.wav")

        args = seen[0]
        at = args.index("-protocol_whitelist")
        assert args[at + 1] == "file,pipe"
        assert at < args.index("-i")


def job_input(**overrides):
    payload = {
        "schema": SCHEMA,
        "audio": {"type": "url", "url": "https://media.example.com/a.ogg"},
        "model": "ivrit-ai/whisper-large-v3-turbo-ct2",
    }
    payload.update(overrides)
    return {"input": payload}


class TestHandlerErrors:
    def test_decode_failure_carries_the_bad_media_marker(self, monkeypatch):
        def failing(spec):
            raise MediaDecodeError("Failed to decode audio with ffmpeg: Invalid data")

        monkeypatch.setattr(pipeline, "run_job", failing)
        result = handler.handler(job_input())
        assert result["error_kind"] == "bad_media"
        assert result["error"].startswith("[bad_media] ")

    def test_download_failure_and_rejections_are_not_bad_media(self, monkeypatch):
        for error in (MediaError("Failed to download audio: HTTP 403"), JobRejected("Audio URL must use https")):
            def failing(spec, error=error):
                raise error

            monkeypatch.setattr(pipeline, "run_job", failing)
            result = handler.handler(job_input())
            assert "error_kind" not in result
            assert "bad_media" not in result["error"]

    def test_run_job_rejects_policy_violations_before_downloading(self, fake_requests):
        calls, _ = fake_requests
        result = handler.handler(job_input(model="someone/untrusted"))
        assert result["error"].startswith("Rejected:")

        result = handler.handler(job_input(audio={"type": "url", "url": "http://media.example.com/a.ogg"}))
        assert result["error"].startswith("Rejected:")
        assert calls == []
