"""Word -> speaker assignment for the MeetSum ASR worker.

Pure Python (no numpy / torch) so it is testable without a GPU.

Rule per word (times in seconds):
  1. the speaker whose diarization turns overlap the word the most;
  2. otherwise the speaker of the nearest turn within ``nearest_s`` (500 ms);
  3. otherwise the previous word's speaker.
Leading words that still have no speaker take the first assigned speaker.
"""

from __future__ import annotations

from typing import Iterable, List, Optional, Sequence

NEAREST_S = 0.5


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _gap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    """Distance between two intervals (0 when they touch or overlap)."""
    if a_end < b_start:
        return b_start - a_end
    if b_end < a_start:
        return a_start - b_end
    return 0.0


def normalize_turns(turns: Iterable[dict]) -> List[dict]:
    """Drops empty/invalid turns and sorts by start."""
    cleaned = []
    for turn in turns:
        try:
            start = float(turn["start"])
            end = float(turn["end"])
        except (KeyError, TypeError, ValueError):
            continue
        speaker = turn.get("speaker")
        if speaker is None or end <= start:
            continue
        cleaned.append({"start": start, "end": end, "speaker": str(speaker)})
    cleaned.sort(key=lambda item: (item["start"], item["end"]))
    return cleaned


def speaker_for_word(
    word_start: float,
    word_end: float,
    turns: Sequence[dict],
    nearest_s: float = NEAREST_S,
) -> Optional[str]:
    """Rules 1 and 2 for a single word against candidate turns."""
    if word_end < word_start:
        word_end = word_start

    totals: dict = {}
    for turn in turns:
        amount = _overlap(word_start, word_end, turn["start"], turn["end"])
        if amount > 0:
            totals[turn["speaker"]] = totals.get(turn["speaker"], 0.0) + amount
    if totals:
        # Highest overlap; ties go to the speaker seen first (stable order).
        return max(totals.items(), key=lambda item: item[1])[0]

    best: Optional[str] = None
    best_gap = None
    for turn in turns:
        gap = _gap(word_start, word_end, turn["start"], turn["end"])
        if gap <= nearest_s and (best_gap is None or gap < best_gap):
            best, best_gap = turn["speaker"], gap
    return best


def assign_speakers(
    words: Sequence[dict],
    turns: Iterable[dict],
    nearest_s: float = NEAREST_S,
) -> List[dict]:
    """Returns copies of ``words`` (``start``/``end`` seconds) with ``speaker``.

    ``words`` must be sorted by start. With no turns at all every speaker is
    ``None`` (no diarization).
    """
    ordered_turns = normalize_turns(turns)
    result = [dict(word) for word in words]
    if not ordered_turns:
        for word in result:
            word["speaker"] = None
        return result

    pointer = 0
    previous: Optional[str] = None
    for word in result:
        start = float(word.get("start") or 0.0)
        end = float(word.get("end") or start)
        # Turns that ended well before this word can never match it (or any
        # later word, since words are sorted).
        while pointer < len(ordered_turns) and ordered_turns[pointer]["end"] < start - nearest_s:
            pointer += 1
        candidates = []
        index = pointer
        while index < len(ordered_turns) and ordered_turns[index]["start"] <= end + nearest_s:
            candidates.append(ordered_turns[index])
            index += 1

        speaker = speaker_for_word(start, end, candidates, nearest_s) or previous
        word["speaker"] = speaker
        if speaker is not None:
            previous = speaker

    first = next((word["speaker"] for word in result if word["speaker"] is not None), None)
    for word in result:
        if word["speaker"] is not None:
            break
        word["speaker"] = first
    return result
