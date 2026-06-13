require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const {createServer} = require('http');
const {Server} = require('socket.io');
const NodeCache = require('node-cache');
const {HttpsProxyAgent} = require('https-proxy-agent');
const {TikTokConnectionWrapper, getGlobalConnectionCount} = require('./connectionWrapper');
const {clientBlocked} = require('./limiter');
const {SignConfig} = require('tiktok-live-connector');

if (process.env.API_KEY) {
    SignConfig.apiKey = process.env.API_KEY;
    console.info('Using Euler API key from environment');
}

// Optional proxy for all TikTok traffic. Required when the host can't reach
// TikTok directly (e.g. mainland China). got and ws don't honor HTTP_PROXY
// env vars on their own, so we inject an explicit agent into both clients.
const proxyUrl = process.env.PROXY;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
if (proxyAgent) {
    console.info(`Routing TikTok traffic through proxy ${proxyUrl}`);
}

// Event names forwarded from the TikTok connection to the browser.
const FORWARDED_EVENTS = [
    'roomUser', 'member', 'chat', 'gift', 'follow', 'share', 'like',
    'questionNew', 'linkMicBattle', 'linkMicArmies', 'liveIntro', 'emote', 'envelope',
];

// Recursively produce a JSON-safe clone:
//  - BigInt -> string (JSON / socket.io-parser can't serialize BigInt)
//  - Buffer / typed arrays / ArrayBuffer -> dropped (these are raw, unparsed
//    protobuf byte fields like `deprecated*` / `userVipInfo` / `stats` that the
//    frontend never reads; left in place they make socket.io emit a binary
//    packet the client decoder rejects with "parse error").
function sanitize(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'bigint') return value.toString();
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return undefined;
    if (Array.isArray(value)) return value.map(sanitize);
    if (typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value)) {
            const cleaned = sanitize(value[key]);
            if (cleaned !== undefined) out[key] = cleaned;
        }
        return out;
    }
    return value;
}

// Map connector v2 field names back to the v1 names the frontend expects.
// v2 flattens the raw protobuf (content/count/total/totalUser) instead of the
// v1 simplified names (comment/likeCount/totalLikeCount/viewerCount).
function normalize(eventName, msg) {
    if (!msg || typeof msg !== 'object') return msg;
    const m = {...msg};

    // Coerce protobuf int64 values (which arrive as BigInt or numeric strings) to
    // plain numbers so the frontend's `typeof x === 'number'` checks pass.
    const num = (v) => {
        if (typeof v === 'bigint') return Number(v);
        if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
        return v;
    };

    switch (eventName) {
        case 'chat':
            if (m.comment == null && m.content != null) m.comment = m.content;
            break;
        case 'like':
            if (m.likeCount == null && m.count != null) m.likeCount = num(m.count);
            if (m.totalLikeCount == null && m.total != null) m.totalLikeCount = num(m.total);
            break;
        case 'roomUser':
            // v2 has no concurrent `viewerCount`; `total` is current (often 0 for
            // broadcasters that hide it), `totalUser` is cumulative since stream start.
            if (m.viewerCount == null) m.viewerCount = num(m.total) || num(m.totalUser) || 0;
            break;
        case 'gift': {
            // TikTok omits gift metadata from the event; fill it from the room gift
            // list (extendedGiftInfo) fetched on connect.
            const info = m.extendedGiftInfo;
            if (m.giftName == null && info?.name != null) m.giftName = info.name;
            if (m.describe == null && info?.describe != null) m.describe = info.describe;
            if (m.diamondCount == null && info?.diamond_count != null) m.diamondCount = info.diamond_count;
            if (m.giftPictureUrl == null && info?.image?.url_list?.length) m.giftPictureUrl = info.image.url_list[0];
            m.diamondCount = num(m.diamondCount);
            m.repeatCount = num(m.repeatCount);
            break;
        }
    }
    return m;
}

function applyProxy(options) {
    if (!proxyAgent) return options;
    return {
        ...options,
        webClientOptions: {
            ...options.webClientOptions,
            agent: {https: proxyAgent, http: proxyAgent},
        },
        wsClientOptions: {
            ...options.wsClientOptions,
            agent: proxyAgent,
        },
    };
}

const app = express();
const httpServer = createServer(app);

// Bypass token cache (tokens valid for 24 hours)
const bypassTokens = new NodeCache({ stdTTL: 86400 });

// Enable cross-origin resource sharing
const io = new Server(httpServer, {
    cors: {
        origin: '*'
    }
});

async function verifyRecaptcha(token) {
    const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${encodeURIComponent(process.env.RECAPTCHA_SECRET_KEY)}&response=${encodeURIComponent(token)}`;
    const response = await fetch(verifyUrl, { method: 'POST' });
    const result = await response.json();
    return result.success;
}

io.on('connection', (socket) => {
    let tiktokConnectionWrapper;

    console.info('New connection from origin', socket.handshake.headers['origin'] || socket.handshake.headers['referer']);

    socket.on('setUniqueId', async (uniqueId, options) => {

        // Prohibit the client from specifying these options (for security reasons)
        if (typeof options === 'object' && options) {
            delete options.requestOptions;
            delete options.websocketOptions;
        } else {
            options = {};
        }

        // Verify reCAPTCHA v2 or bypass token if configured
        if (process.env.RECAPTCHA_SECRET_KEY) {
            const recaptchaToken = options.recaptchaToken;
            const bypassToken = options.bypassToken;
            delete options.recaptchaToken;
            delete options.bypassToken;

            if (bypassToken && bypassTokens.has(bypassToken)) {
                // Valid bypass token, allow through
            } else if (recaptchaToken) {
                try {
                    const success = await verifyRecaptcha(recaptchaToken);
                    if (!success) {
                        socket.emit('tiktokDisconnected', 'reCAPTCHA verification failed. Please try again.');
                        return;
                    }
                } catch (err) {
                    console.error('reCAPTCHA verification error:', err);
                    socket.emit('tiktokDisconnected', 'reCAPTCHA verification error. Please try again.');
                    return;
                }
            } else {
                socket.emit('tiktokDisconnected', 'reCAPTCHA verification required.');
                return;
            }
        }

        // Session ID in .env file is optional
        if (process.env.SESSIONID) {
            options.sessionId = process.env.SESSIONID;
            console.info('Using SessionId');
        }

        // Check if rate limit exceeded
        if (process.env.ENABLE_RATE_LIMIT && clientBlocked(io, socket)) {
            socket.emit('tiktokDisconnected', 'You have opened too many connections or made too many connection requests. Please reduce the number of connections/requests or host your own server instance. The connections are limited to avoid that the server IP gets blocked by TokTok.');
            return;
        }

        // Disconnect previous connection if exists
        if (tiktokConnectionWrapper) {
            tiktokConnectionWrapper.disconnect();
        }

        // Fetch the room gift list on connect so gift events carry name / diamond
        // cost / image (via extendedGiftInfo), which TikTok omits from the raw event.
        options.enableExtendedGiftInfo = true;

        // Normalize username: tolerate a leading '@' typed by the user
        const normalizedUniqueId = typeof uniqueId === 'string' ? uniqueId.trim().replace(/^@/, '') : uniqueId;

        // Connect to the given username (uniqueId)
        try {
            tiktokConnectionWrapper = new TikTokConnectionWrapper(normalizedUniqueId, applyProxy(options), true);
            tiktokConnectionWrapper.connect();
        } catch (err) {
            socket.emit('tiktokDisconnected', err.toString());
            return;
        }

        // Redirect wrapper control events once
        tiktokConnectionWrapper.once('connected', state => socket.emit('tiktokConnected', sanitize(state)));
        tiktokConnectionWrapper.once('disconnected', reason => socket.emit('tiktokDisconnected', reason));

        // Notify client when stream ends
        tiktokConnectionWrapper.connection.on('streamEnd', () => socket.emit('streamEnd'));

        // Redirect message events (payloads sanitized so socket.io can serialize them)
        FORWARDED_EVENTS.forEach(eventName => {
            tiktokConnectionWrapper.connection.on(eventName, msg => socket.emit(eventName, sanitize(normalize(eventName, msg))));
        });
    });

    socket.on('disconnect_tiktok', () => {
        if (tiktokConnectionWrapper) {
            tiktokConnectionWrapper.disconnect();
            tiktokConnectionWrapper = null;
        }
    });

    socket.on('disconnect', () => {
        if (tiktokConnectionWrapper) {
            tiktokConnectionWrapper.disconnect();
        }
    });
});

// Emit global connection statistics
setInterval(() => {
    io.emit('statistic', {globalConnectionCount: getGlobalConnectionCount()});
}, 5000)

// reCAPTCHA config endpoint
app.get('/recaptcha-config', (req, res) => {
    res.json({
        enabled: !!process.env.RECAPTCHA_SITE_KEY,
        siteKey: process.env.RECAPTCHA_SITE_KEY || null
    });
});

// Generate a bypass token after verifying reCAPTCHA v2 (for overlay URLs)
app.post('/generate-overlay-token', express.json(), async (req, res) => {
    if (!process.env.RECAPTCHA_SECRET_KEY) {
        return res.json({ token: null });
    }

    const { recaptchaToken } = req.body;
    if (!recaptchaToken) {
        return res.status(400).json({ error: 'reCAPTCHA token required' });
    }

    try {
        const success = await verifyRecaptcha(recaptchaToken);
        if (!success) {
            return res.status(403).json({ error: 'reCAPTCHA verification failed' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        bypassTokens.set(token, true);
        return res.json({ token });
    } catch (err) {
        console.error('reCAPTCHA verification error:', err);
        return res.status(500).json({ error: 'Verification error' });
    }
});

// Serve frontend files
app.use(express.static('public'));

// Start http listener
const port = process.env.PORT || 8081;
httpServer.listen(port);
console.info(`Server running! Please visit http://localhost:${port}`);
