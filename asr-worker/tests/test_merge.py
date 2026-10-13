"""Word/speaker merge + schema tests. Pure Python: no GPU, torch or models."""

import base64
import json
import os

import pytest

from merge import assign_speakers, normalize_turns, speaker_for_word
from schema import SCHEMA, SchemaError, build_output, parse_job_input


def word(start, end, text="w"):
    return {"start": start, "end": end, "text": text, "confidence": 0.9}


TURNS = [
    {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_00"},
    {"start": 2.0, "end": 5.0, "speaker": "SPEAKER_01"},
    {"start": 7.0, "end": 9.0, "speaker": "SPEAKER_00"},
]


class TestSpeakerForWord:
    def test_max_overlap_wins(self):
        # 1.6-2.6 overlaps SPEAKER_00 by 0.4 s and SPEAKER_01 by 0.6 s.
        assert speaker_for_word(1.6, 2.6, TURNS) == "SPEAKER_01"
        assert speaker_for_word(1.0, 2.2, TURNS) == "SPEAKER_00"

    def test_overlap_summed_per_speaker(self):
        turns = [
            {"start": 0.0, "end": 0.3, "speaker": "A"},
            {"start": 0.3, "end": 0.7, "speaker": "B"},
            {"start": 0.7, "end": 1.0, "speaker": "A"},
        ]
        assert speaker_for_word(0.0, 1.0, turns) == "A"

    def test_nearest_turn_within_500ms(self):
        # Word in the 5.0-7.0 gap: 0.3 s after SPEAKER_01, 1.5 s before SPEAKER_00.
        assert speaker_for_word(5.3, 5.5, TURNS) == "SPEAKER_01"
        assert speaker_for_word(6.6, 6.8, TURNS) == "SPEAKER_00"

    def test_nothing_within_500ms(self):
        assert speaker_for_word(5.8, 6.2, TURNS) is None


class TestAssignSpeakers:
    def test_rules_in_order(self):
        words = [
            word(0.1, 0.5, "שלום"),
            word(1.8, 2.6, "לכולם"),
            word(5.2, 5.4, "אה"),
            word(5.9, 6.1, "כן"),  # no turn within 500 ms -> previous speaker
            word(7.5, 8.0, "טוב"),
        ]
        result = assign_speakers(words, TURNS)
        assert [w["speaker"] for w in result] == [
            "SPEAKER_00",
            "SPEAKER_01",
            "SPEAKER_01",
            "SPEAKER_01",
            "SPEAKER_00",
        ]
        # Inputs are not mutated; other fields survive.
        assert "speaker" not in words[0]
        assert result[0]["text"] == "שלום" and result[0]["confidence"] == 0.9

    def test_leading_unassigned_words_take_first_speaker(self):
        turns = [{"start": 10.0, "end": 12.0, "speaker": "SPEAKER_03"}]
        result = assign_speakers([word(0.0, 0.5), word(10.5, 11.0)], turns)
        assert [w["speaker"] for w in result] == ["SPEAKER_03", "SPEAKER_03"]

    def test_no_turns_means_no_speakers(self):
        assert [w["speaker"] for w in assign_speakers([word(0, 1)], [])] == [None]

    def test_unsorted_and_invalid_turns(self):
        turns = [
            {"start": 3.0, "end": 4.0, "speaker": "B"},
            {"start": 1.0, "end": 0.5, "speaker": "X"},  # inverted -> dropped
            {"start": 0.0, "end": 1.0},  # no speaker -> dropped
            {"start": 0.0, "end": 1.0, "speaker": "A"},
        ]
        assert [t["speaker"] for t in normalize_turns(turns)] == ["A", "B"]
        result = assign_speakers([word(0.2, 0.4), word(3.1, 3.3)], turns)
        assert [w["speaker"] for w in result] == ["A", "B"]

    def test_zero_length_word_uses_nearest(self):
        result = assign_speakers([word(2.0, 2.0)], TURNS)
        assert result[0]["speaker"] in {"SPEAKER_00", "SPEAKER_01"}

    def test_many_words_long_meeting(self):
        turns = [{"start": float(i), "end": float(i + 1), "speaker": f"S{i % 3}"} for i in range(3600)]
        words = [word(i + 0.2, i + 0.6) for i in range(3600)]
        result = assign_speakers(words, turns)
        assert all(w["speaker"] == f"S{i % 3}" for i, w in enumerate(result))


class TestSchema:
    def test_parses_url_and_blob_input(self):
        job = parse_job_input(
            {
                "schema": SCHEMA,
                "audio": {"type": "url", "url": "https://media.example.com/a.ogg?sig=1"},
                "language": "he",
                "diarize": True,
                "min_speakers": 2,
                "max_speakers": 4,
                "hotwords": "Supabase, Gemini",
            }
        )
        assert job.audio.url.startswith("https://") and job.min_speakers == 2 and job.hotwords == "Supabase, Gemini"

        blob = parse_job_input(
            {"schema": SCHEMA, "audio": {"type": "blob", "data": base64.b64encode(b"OggS").decode()}, "language": None}
        )
        assert blob.audio.data == b"OggS" and blob.language is None

    @pytest.mark.parametrize(
        "raw",
        [
            None,
            {"schema": "other"},
            {"schema": SCHEMA, "audio": {"type": "ftp"}},
            {"schema": SCHEMA, "audio": {"type": "url", "url": "file:///etc/passwd"}},
            {"schema": SCHEMA, "audio": {"type": "blob", "data": "***"}},
            {"schema": SCHEMA, "audio": {"type": "url", "url": "https://x"}, "min_speakers": 5, "max_speakers": 2},
            {"schema": SCHEMA, "audio": {"type": "url", "url": "https://x"}, "max_speakers": True},
        ],
    )
    def test_rejects_bad_input(self, raw):
        with pytest.raises(SchemaError):
            parse_job_input(raw)

    def test_builds_output(self):
        output = build_output(
            model="m",
            language="he",
            duration_s=12.3456,
            words=[
                {"start": 0.12345, "end": 0.5, "text": " שלום ", "confidence": 0.98765, "speaker": "SPEAKER_00"},
                {"start": 0.6, "end": 0.7, "text": "  ", "confidence": None, "speaker": None},
            ],
            diarization="provider",
            speakers=[{"label": "SPEAKER_00", "embedding": [0.123456789]}, {"label": "SPEAKER_01", "embedding": None}],
            embedding_model="pyannote/speaker-diarization-community-1",
        )
        assert output["schema"] == SCHEMA
        assert output["duration_s"] == 12.346
        assert output["words"] == [
            {"start": 0.123, "end": 0.5, "text": "שלום", "confidence": 0.988, "speaker": "SPEAKER_00"}
        ]
        assert output["speakers"][0]["embedding"] == [0.12346]
        assert output["speakers"][1]["embedding"] is None
        json.dumps(output)  # serializable


def test_handler_rejects_bad_schema_without_gpu_imports():
    from handler import handler

    result = handler({"input": {"schema": "nope"}})
    assert "error" in result and "could not read" in result["error"]


def test_sample_input_is_valid():
    path = os.path.join(os.path.dirname(__file__), "..", "test_input.json")
    with open(path, encoding="utf-8") as handle:
        sample = json.load(handle)
    job = parse_job_input(sample["input"])
    assert job.audio.type == "url" and job.diarize
