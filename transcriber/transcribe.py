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
    WHISPER_MAX_SEG   max seconds before a forced flush (default: 4)
    WHISPER_BEAM      beam size; 1 = fastest, higher = more accurate/slower (default: 1)
    WHISPER_CPU_THREADS  ctranslate2 CPU threads (default: physical cores)
    WHISPER_DEBUG     set to anything to log timing to stderr
"""

import sys
import os
import json
import time
import numpy as np

SAMPLING_RATE = 16000
FRAME = 0.32                     # seconds of audio read per loop (finer = faster endpointing)
SILENCE_RMS = 0.008             # below this RMS a frame is considered silence
SILENCE_HANG = 0.35            # seconds of trailing silence that ends a phrase
MIN_SEG = 0.8                   # don't flush segments shorter than this
DEBUG = os.environ.get("WHISPER_DEBUG", "") != ""


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def dbg(msg):
    if DEBUG:
        sys.stderr.write(f"[transcribe] {msg}\n")
        sys.stderr.flush()


class Segmenter:
    def __init__(self, model, language, max_seg, beam_size):
        self.model = model
        self.language = language or None
        self.max_seg = max_seg
        self.beam_size = beam_size
        self.buffer = np.array([], dtype=np.float32)
        self.segment_start = 0.0      # absolute stream time of buffer[0]
        self.stream_time = 0.0        # absolute time of all audio consumed
        self.silence_run = 0.0        # trailing silence accumulated
        self.had_speech = False
        self.detected_language = None
        self.last_final_text = ""     # fed back as context to improve accuracy

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

    def _transcribe(self):
        segments, info = self.model.transcribe(
            self.buffer,
            language=self.language,
            beam_size=self.beam_size,
            temperature=0.0,
            no_repeat_ngram_size=3,
            condition_on_previous_text=False,
            # Feed the previous phrase as context — improves accuracy/continuity for
            # free (unlike condition_on_previous_text it won't trigger runaway loops).
            initial_prompt=self.last_final_text or None,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=250, threshold=0.5),
        )
        text = " ".join(s.text.strip() for s in segments
                        if not (s.no_speech_prob and s.no_speech_prob > 0.6)).strip()
        return text, info

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
            self.last_final_text = text
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


def main():
    model_size = os.environ.get("WHISPER_MODEL", "small")
    language = os.environ.get("WHISPER_LANGUAGE", "").strip()
    compute_type = os.environ.get("WHISPER_COMPUTE", "int8")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    max_seg = float(os.environ.get("WHISPER_MAX_SEG", "4"))
    beam_size = int(os.environ.get("WHISPER_BEAM", "1"))
    # Default to physical cores; oversubscribing logical (hyperthreaded) cores slows
    # down ctranslate2 int8 GEMM. Override with WHISPER_CPU_THREADS.
    cpu_threads = int(os.environ.get("WHISPER_CPU_THREADS", str(max(1, (os.cpu_count() or 4) // 2))))

    from faster_whisper import WhisperModel

    emit({"type": "status", "message": f"loading model {model_size} ({device}/{compute_type}, {cpu_threads} threads)"})
    model = WhisperModel(model_size, device=device, compute_type=compute_type,
                         cpu_threads=cpu_threads, num_workers=1)
    emit({"type": "ready"})

    seg = Segmenter(model, language, max_seg, beam_size)
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

        # Transcribe each segment exactly once (on endpoint or max length). Re-running
        # Whisper on a growing buffer for live partials cannot keep up on CPU, so we
        # avoid redundant work and emit a final per phrase — this stays real-time.
        try:
            if seg.should_flush():
                seg.flush()
        except Exception as exc:
            emit({"type": "error", "message": str(exc)})
            seg._reset()


if __name__ == "__main__":
    main()
