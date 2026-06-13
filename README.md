<div align="center">

# TikTok Live Spy

**实时捕捉 TikTok 直播间的弹幕、礼物与互动数据 · Real-time capture of TikTok LIVE chat, gifts & engagement**

[**English**](README.md) · [中文](README.zh-CN.md)

<img src="docs/screenshot.png" alt="TikTok Live Spy screenshot" width="100%">

</div>

---

## Overview

**TikTok Live Spy** connects to any public TikTok LIVE room and streams its real-time
data to a clean four-column web dashboard:

1. **Chats** — live comments, likes, follows, shares and member joins
2. **Gifts** — gifts with name, diamond value and icon
3. **Transcript** — the host's speech transcribed in real time and locally with
   [Whisper](https://github.com/openai/whisper) (streaming, low-latency, timestamped)
4. **Live Video** — the TikTok live video itself, played in-browser

It is built for monitoring and analyzing live-stream engagement, and is designed as a
single, self-contained codebase you can freely customize and extend.

Under the hood it merges two upstream projects by [@zerodytrash](https://github.com/zerodytrash):
the **[TikTok-Live-Connector](https://github.com/zerodytrash/TikTok-Live-Connector)** library
(vendored locally so you can edit and rebuild it) and the
**[TikTok-Chat-Reader](https://github.com/zerodytrash/TikTok-Chat-Reader)** web app, then
adapts them to the latest connector (v2.x) with fixes for proxying, event serialization,
and field-mapping so everything works end-to-end out of the box.

## Features

- 🔴 **Live event stream** — chat, gifts, likes, follows, shares and joins in real time
- 📊 **Room stats** — concurrent viewers, total likes and earned diamonds
- 🎁 **Gift details** — gift name, diamond cost and icon (via the room gift list)
- 🗣️ **Live transcription** — the host's speech transcribed locally with Whisper
  (faster-whisper), streamed with timestamps and low latency — no cloud, no API cost
- 📺 **Live video** — the TikTok stream played in-browser via an HLS proxy (works even
  when the CDN blocks cross-origin or geo-restricted browser requests)
- 🧱 **Editable connector** — the TikTok connector lives in `connector/` as an npm workspace
- 🌐 **Proxy support** — route all TikTok traffic through your own proxy when needed
- 🖥️ **OBS overlay** — a transparent overlay page for browser sources

## Project structure

```
tiktok_live_spy/
├── server.js              # Express + Socket.IO backend
├── connectionWrapper.js   # Reconnect / error-handling wrapper around the connector
├── limiter.js             # Per-IP rate limiting
├── public/                # Frontend (index.html, app.js, connection.js, obs.html, style.css)
├── transcription.js       # ffmpeg → Whisper pipeline manager (Node side)
├── transcriber/           # Python Whisper streaming transcriber
│   ├── transcribe.py      # endpoint-segmented faster-whisper streaming
│   └── requirements.txt
├── connector/             # Vendored TikTok-Live-Connector library (npm workspace)
│   └── src/               # Edit the connector here, then `npm run build:connector`
├── docs/                  # Screenshots and assets
├── .env.example           # Copy to .env and fill in your own settings
└── package.json           # Root app + workspace config
```

## Requirements

- [Node.js](https://nodejs.org/) >= 20
- For the live **video** column and **transcription**:
  - [ffmpeg](https://ffmpeg.org/) on your `PATH` (`brew install ffmpeg`, `apt install ffmpeg`, …)
  - [Python](https://www.python.org/) 3.9+ (only for transcription)

> The chat/gift columns work with Node alone. ffmpeg + Python are only needed for the
> video and transcript columns; set `ENABLE_TRANSCRIPTION=0` to skip transcription.

## Setup

```bash
# 1. Install Node dependencies (also builds the vendored connector)
npm install

# 2. (For transcription) create the Python environment
python3 -m venv transcriber/.venv
transcriber/.venv/bin/pip install -r transcriber/requirements.txt

# 3. Create your local config from the template
cp .env.example .env
#    then open .env and fill in the values (see Configuration below)

# 4. Start the server
npm start
```

Open <http://localhost:8081> and enter the **@username** of a user who is currently live.
The Whisper model (~480 MB for `small`) downloads automatically on first use.

## Configuration

All configuration lives in `.env` (which is **git-ignored** — never commit it). Copy
`.env.example` and fill in your own values:

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Web server port (default `8081`) |
| `API_KEY` | Recommended | Your own [Euler Stream](https://www.eulerstream.com/) API key, used to sign requests for reliable connections. Get a free key from their site. |
| `PROXY` | When needed | Proxy URL for all TikTok traffic (e.g. `http://127.0.0.1:7897`). Required if your network can't reach TikTok directly. |
| `SESSIONID` | No | A TikTok `sessionid` cookie, for streams that require login |
| `ENABLE_RATE_LIMIT` | No | Set to any non-empty value to enable per-IP rate limiting |
| `RECAPTCHA_SITE_KEY` / `RECAPTCHA_SECRET_KEY` | No | Google reCAPTCHA v2 keys to gate connections |
| `ENABLE_TRANSCRIPTION` | No | `0`/`false` disables the transcript column (default on) |
| `WHISPER_MODEL` | No | `tiny` / `base` / `small` / `medium` — bigger = more accurate, higher latency (default `small`) |
| `WHISPER_LANGUAGE` | No | Force a language code (e.g. `en`, `ja`, `zh`); empty = auto-detect |
| `WHISPER_DEVICE` | No | `cpu` or `cuda` (default `cpu`) |
| `WHISPER_COMPUTE` | No | ctranslate2 compute type: `int8` (default), `float16`, `float32` |

> **Transcription latency.** On a CPU without a GPU, `small` keeps up roughly in real
> time (~2–4 s latency); switch `WHISPER_MODEL` to `base` for noticeably lower latency,
> or `medium`/`cuda` for more accuracy if you have a GPU.

> **Keep your secrets private.** `API_KEY`, `SESSIONID` and reCAPTCHA secrets are
> personal credentials — store them only in your local `.env`, never in source control.

## Development

| Command | Description |
|---------|-------------|
| `npm start` | Run the server |
| `npm run dev` | Run with `--watch` (auto-restart on changes) |
| `npm run build:connector` | Rebuild the vendored connector after editing `connector/src` |

The `/obs.html` page provides a transparent overlay suitable for OBS browser sources.

## How it works

```
                            ┌─ events ── connector (proxy) ── TikTok LIVE
Browser ⇄ Socket.IO ⇄ server ┤
                            ├─ video  ── HLS proxy ────────── TikTok CDN
                            └─ audio  ── ffmpeg ─ Whisper (Python) ─ transcript
```

- **Events**: the backend connects to the room through the connector (optionally via your
  proxy and Euler Stream signing), normalizes/sanitizes each event, and forwards it over Socket.IO.
- **Video**: the room's HLS URL is proxied through the server (`/hls`), so the browser only
  talks to our origin — sidestepping CORS and geo-blocked CDNs.
- **Transcript**: ffmpeg pulls the live audio, pipes 16 kHz PCM into a local faster-whisper
  streaming process, and the committed text (with timestamps) is pushed to the browser.

## Notes & limitations

- TikTok's unofficial API can rate-limit or block server IPs. An Euler Stream `API_KEY`
  makes connections far more reliable.
- TikTok no longer includes user **avatars** in most live events, so chat avatars may be
  blank by design. Gift/avatar images load directly from TikTok's CDN in your browser and
  may not load on networks where that CDN is blocked.
- This project uses an unofficial reverse-engineered API and is intended for educational
  and analytical use.

## Credits

Both upstream projects are by [@zerodytrash](https://github.com/zerodytrash) and are MIT
licensed. This repository combines and adapts them.

## License

MIT
