#!/usr/bin/env python3
"""
Low-latency streaming transcriber (endpoint-segmented).

Reads raw 16 kHz mono signed-16-bit-LE PCM from stdin (produced by ffmpeg pulling
the TikTok LIVE audio) and emits transcripts as JSON lines on stdout:

    {"type": "ready"}
    {"type": "language", "language": "ja"}
    {"type": "partial", "text": "phrase still being spoken"}
    {"type": "final", "start": 12.3, "end": 14.1, "text": "a finished phrase"}

Strategy: accumulate audio and detect end-of-phrase with a light energy-based VAD
(a short run of silence after speech), or flush at a maximum segment length. Each
phrase is transcribed exactly once with Whisper (faster-whisper). This keeps CPU
work bounded and output reliable on machines without a GPU — unlike re-transcribing
an ever-growing buffer, which falls behind real time on CPU.

Config via environment variables:
    WHISPER_MODEL     model size (default: small)
    WHISPER_LANGUAGE  fixed language code, or empty for auto-detect (default: auto)
    WHISPER_COMPUTE   ctranslate2 compute type (default: int8)
    WHISPER_DEVICE    cpu | cuda (default: cpu)
    WHISPER_MAX_SEG   max seconds before a forced flush (default: 8)
    WHISPER_DEBUG     set to anything to log timing to stderr
"""

import sys
import os
import json
import time
import numpy as np

SAMPLING_RATE = 16000
FRAME = 0.5                      # seconds of audio read per loop
SILENCE_RMS = 0.008             # below this RMS a frame is considered silence
SILENCE_HANG = 0.6              # seconds of trailing silence that ends a phrase
MIN_SEG = 1.0                   # don't flush segments shorter than this
PARTIAL_EVERY = 2.5             # emit a live partial after this much un-flushed speech
DEBUG = os.environ.get("WHISPER_DEBUG", "") != ""


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def dbg(msg):
    if DEBUG:
        sys.stderr.write(f"[transcribe] {msg}\n")
        sys.stderr.flush()


class Segmenter:
    def __init__(self, model, language, max_seg):
        self.model = model
        self.language = language or None
        self.max_seg = max_seg
        self.buffer = np.array([], dtype=np.float32)
        self.segment_start = 0.0      # absolute stream time of buffer[0]
        self.stream_time = 0.0        # absolute time of all audio consumed
        self.silence_run = 0.0        # trailing silence accumulated
        self.had_speech = False
        self.detected_language = None
        self.last_partial_len = 0.0

    def add(self, audio):
        self.buffer = np.append(self.buffer, audio)
        self.stream_time += len(audio) / SAMPLING_RATE

        rms = float(np.sqrt(np.mean(audio ** 2))) if len(audio) else 0.0
        if rms >= SILENCE_RMS:
            self.had_speech = True
            self.silence_run = 0.0
        else:
            self.silence_run += len(audio) / SAMPLING_RATE

    @property
    def seg_len(self):
        return len(self.buffer) / SAMPLING_RATE

    def should_flush(self):
        if self.seg_len >= self.max_seg:
            return True
        if self.had_speech and self.silence_run >= SILENCE_HANG and self.seg_len >= MIN_SEG:
            return True
        return False

    def should_partial(self):
        return self.had_speech and (self.seg_len - self.last_partial_len) >= PARTIAL_EVERY

    def _transcribe(self):
        segments, info = self.model.transcribe(
            self.buffer,
            language=self.language,
            beam_size=1,
            temperature=0.0,
            no_repeat_ngram_size=3,
            condition_on_previous_text=False,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=300, threshold=0.5),
        )
        text = " ".join(s.text.strip() for s in segments
                        if not (s.no_speech_prob and s.no_speech_prob > 0.6)).strip()
        return text, info

    def partial(self):
        self.last_partial_len = self.seg_len
        t0 = time.time()
        text, info = self._transcribe()
        dbg(f"partial seg={self.seg_len:.1f}s infer={time.time()-t0:.2f}s text='{text[:40]}'")
        if text:
            emit({"type": "partial", "text": text})

    def flush(self):
        seg_len = self.seg_len
        if not self.had_speech or seg_len < MIN_SEG:
            self._reset()
            return
        t0 = time.time()
        text, info = self._transcribe()
        dbg(f"flush   seg={seg_len:.1f}s infer={time.time()-t0:.2f}s text='{text[:40]}'")

        if self.detected_language is None and getattr(info, "language", None):
            self.detected_language = info.language
            emit({"type": "language", "language": info.language})

        if text:
            emit({
                "type": "final",
                "start": round(self.segment_start, 2),
                "end": round(self.segment_start + seg_len, 2),
                "text": text,
            })
        else:
            emit({"type": "partial", "text": ""})
        self._reset()

    def _reset(self):
        self.buffer = np.array([], dtype=np.float32)
        self.segment_start = self.stream_time
        self.silence_run = 0.0
        self.had_speech = False
        self.last_partial_len = 0.0


def main():
    model_size = os.environ.get("WHISPER_MODEL", "small")
    language = os.environ.get("WHISPER_LANGUAGE", "").strip()
    compute_type = os.environ.get("WHISPER_COMPUTE", "int8")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    max_seg = float(os.environ.get("WHISPER_MAX_SEG", "8"))

    from faster_whisper import WhisperModel

    emit({"type": "status", "message": f"loading model {model_size} ({device}/{compute_type})"})
    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    emit({"type": "ready"})

    seg = Segmenter(model, language, max_seg)
    bytes_per_frame = int(SAMPLING_RATE * FRAME) * 2
    stdin = sys.stdin.buffer

    while True:
        raw = stdin.read(bytes_per_frame)
        if not raw:
            break
        if len(raw) % 2:
            raw = raw[:-1]
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        seg.add(audio)

        try:
            if seg.should_flush():
                seg.flush()
            elif seg.should_partial():
                seg.partial()
        except Exception as exc:
            emit({"type": "error", "message": str(exc)})
            seg._reset()


if __name__ == "__main__":
    main()
