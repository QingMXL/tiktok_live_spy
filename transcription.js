const {spawn} = require('child_process');
const path = require('path');
const readline = require('readline');

const DEFAULT_PYTHON = path.join(__dirname, 'transcriber', '.venv', 'bin', 'python');
const SCRIPT = path.join(__dirname, 'transcriber', 'transcribe.py');

/**
 * Pull the live audio with ffmpeg, pipe raw PCM into the Python Whisper streaming
 * transcriber, and surface its JSON events via callbacks.
 *
 * @param {string} audioUrl  TikTok pull URL (FLV or HLS) to read audio from
 * @param {object} opts
 * @param {string} [opts.proxy]    proxy URL for ffmpeg's network access
 * @param {(event: object) => void} opts.onEvent  receives transcriber JSON events
 * @param {(line: string) => void}  [opts.onLog]  receives diagnostic log lines
 */
function startTranscription(audioUrl, {proxy, onEvent, onLog = () => {}}) {
    const pythonBin = process.env.PYTHON_BIN || DEFAULT_PYTHON;
    const ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg';

    const ffmpegEnv = {...process.env};
    if (proxy) {
        ffmpegEnv.http_proxy = proxy;
        ffmpegEnv.https_proxy = proxy;
    }

    // ffmpeg: pull stream, drop video, downmix to 16 kHz mono s16le on stdout.
    const ffmpeg = spawn(ffmpegBin, [
        '-hide_banner', '-loglevel', 'error',
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-i', audioUrl,
        '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1',
    ], {env: ffmpegEnv, stdio: ['ignore', 'pipe', 'pipe']});

    const pythonEnv = {
        ...process.env,
        WHISPER_MODEL: process.env.WHISPER_MODEL || 'small',
        WHISPER_LANGUAGE: process.env.WHISPER_LANGUAGE || '',
        WHISPER_COMPUTE: process.env.WHISPER_COMPUTE || 'int8',
        WHISPER_DEVICE: process.env.WHISPER_DEVICE || 'cpu',
    };
    if (proxy) {
        // Allow the first-run model download to use the proxy too.
        pythonEnv.HTTPS_PROXY = pythonEnv.HTTPS_PROXY || proxy;
        pythonEnv.HTTP_PROXY = pythonEnv.HTTP_PROXY || proxy;
    }

    const python = spawn(pythonBin, [SCRIPT], {env: pythonEnv, stdio: ['pipe', 'pipe', 'pipe']});

    ffmpeg.stdout.pipe(python.stdin);

    const rl = readline.createInterface({input: python.stdout});
    rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
            onEvent(JSON.parse(line));
        } catch (err) {
            onLog(`transcriber: unparseable line: ${line}`);
        }
    });

    ffmpeg.stderr.on('data', (d) => onLog(`ffmpeg: ${d.toString().trim()}`));
    python.stderr.on('data', (d) => onLog(`python: ${d.toString().trim()}`));

    let stopped = false;
    const cleanup = () => {
        if (stopped) return;
        stopped = true;
        rl.close();
        // Closing ffmpeg ends the PCM stream; python exits on EOF.
        try { ffmpeg.stdout.unpipe(python.stdin); } catch (_) {}
        try { python.stdin.end(); } catch (_) {}
        try { ffmpeg.kill('SIGKILL'); } catch (_) {}
        try { python.kill('SIGTERM'); } catch (_) {}
    };

    ffmpeg.on('error', (err) => onLog(`ffmpeg spawn error: ${err.message}`));
    python.on('error', (err) => onLog(`python spawn error: ${err.message}`));
    ffmpeg.on('exit', (code) => { onLog(`ffmpeg exited (${code})`); });
    python.on('exit', (code) => { onLog(`python exited (${code})`); });

    return {stop: cleanup};
}

/**
 * Extract a playable HLS URL (for the browser video) and an audio-friendly URL
 * (for transcription) from the connector's roomInfo object.
 */
function extractStreamUrls(roomInfo) {
    const data = roomInfo && roomInfo.data ? roomInfo.data : roomInfo || {};
    const su = data.stream_url || {};
    const flv = su.flv_pull_url || {};

    const hls = su.hls_pull_url || (data.multi_stream_url && data.multi_stream_url.hls_pull_url) || null;
    // Prefer the lowest-bitrate FLV for audio extraction; fall back to HLS.
    const audio = flv.SD1 || flv.LD1 || flv.HD1 || Object.values(flv)[0] || hls || null;

    return {hls: hls || null, audio: audio || null};
}

module.exports = {startTranscription, extractStreamUrls};
