const express = require('express');
const session = require('express-session');
const compression = require('compression');
const axios = require('axios');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client: SshClient } = require('ssh2');

// HTTP keep-alive agent so axios reuses connections to the receiver
const _keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 10, maxFreeSockets: 5 });
// Reused sockets accumulate error listeners — raise the limit to avoid warnings
require('events').EventEmitter.defaultMaxListeners = 30;

const app = express();
const PORT = process.env.PORT || 2000;

// ─── Live log streaming via SSE ──────────────────────────────────────────────
const logClients = new Set();

function broadcastLog(level, args) {
  const epochMs = Date.now();
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const payload = JSON.stringify({ epochMs, level, msg });
  for (const res of logClients) {
    res.write(`data: ${payload}\n\n`);
  }
}

const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

console.log   = (...args) => { _origLog(...args);   broadcastLog('info',  args); };
console.warn  = (...args) => { _origWarn(...args);   broadcastLog('warn',  args); };
console.error = (...args) => { _origError(...args);  broadcastLog('error', args); };

// ─── Config persistence (ENV > config.json > default) ────────────────────────
const CONFIG_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

let _savedConfig = null;
function loadSavedConfig() {
  if (_savedConfig === null) {
    try { _savedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
    catch { _savedConfig = {}; }
  }
  return _savedConfig;
}

function cfg(key, defaultVal) {
  if (process.env[key]) return process.env[key];
  const saved = loadSavedConfig();
  if (saved[key] !== undefined && saved[key] !== '') return String(saved[key]);
  return defaultVal;
}

let ENIGMA2_HOST = cfg('ENIGMA2_HOST', '192.168.1.100');
let ENIGMA2_PORT = parseInt(cfg('ENIGMA2_PORT', '80'), 10);
let ENIGMA2_STREAM_PORT = parseInt(cfg('ENIGMA2_STREAM_PORT', '8001'), 10);
let ENIGMA2_USER = cfg('ENIGMA2_USER', '');
let ENIGMA2_PASSWORD = cfg('ENIGMA2_PASSWORD', '');
let ENIGMA2_SSH_PORT = parseInt(cfg('ENIGMA2_SSH_PORT', '22'), 10);
let ENIGMA2_STREAM_AUTH = cfg('ENIGMA2_STREAM_AUTH', 'false').toLowerCase() === 'true';
let APP_USERNAME = cfg('APP_USERNAME', 'admin');
let APP_PASSWORD = cfg('APP_PASSWORD', 'admin');
let APP_2FA_SECRET = cfg('APP_2FA_SECRET', '');
let SESSION_SECRET = cfg('SESSION_SECRET', 'e2streamhub-change-this-secret');
let FFMPEG_FORCE_VIDEO_TRANSCODE = cfg('FFMPEG_FORCE_VIDEO_TRANSCODE', 'false').toLowerCase() === 'true';
let FFMPEG_PROBESIZE = cfg('FFMPEG_PROBESIZE', '10000000');
let FFMPEG_ANALYZEDURATION = cfg('FFMPEG_ANALYZEDURATION', '10000000');
let FFMPEG_TRANSCODE_PRESET = cfg('FFMPEG_TRANSCODE_PRESET', 'veryfast');
let HLS_SEGMENT_SECONDS = parseInt(cfg('HLS_SEGMENT_SECONDS', '2'), 10);
let HLS_LIST_SIZE = parseInt(cfg('HLS_LIST_SIZE', '4'), 10);

let enigmaBase = `http://${ENIGMA2_HOST}:${ENIGMA2_PORT}`;
let enigmaAuth = ENIGMA2_USER
  ? { username: ENIGMA2_USER, password: ENIGMA2_PASSWORD }
  : null;

let needsSetup = !fs.existsSync(CONFIG_PATH) && !process.env.ENIGMA2_HOST;

function applyConfig() {
  _savedConfig = null;
  ENIGMA2_HOST = cfg('ENIGMA2_HOST', '192.168.1.100');
  ENIGMA2_PORT = parseInt(cfg('ENIGMA2_PORT', '80'), 10);
  ENIGMA2_STREAM_PORT = parseInt(cfg('ENIGMA2_STREAM_PORT', '8001'), 10);
  ENIGMA2_USER = cfg('ENIGMA2_USER', '');
  ENIGMA2_PASSWORD = cfg('ENIGMA2_PASSWORD', '');
  ENIGMA2_SSH_PORT = parseInt(cfg('ENIGMA2_SSH_PORT', '22'), 10);
  ENIGMA2_STREAM_AUTH = cfg('ENIGMA2_STREAM_AUTH', 'false').toLowerCase() === 'true';
  APP_USERNAME = cfg('APP_USERNAME', 'admin');
  APP_PASSWORD = cfg('APP_PASSWORD', 'admin');
  APP_2FA_SECRET = cfg('APP_2FA_SECRET', '');
  FFMPEG_FORCE_VIDEO_TRANSCODE = cfg('FFMPEG_FORCE_VIDEO_TRANSCODE', 'false').toLowerCase() === 'true';
  FFMPEG_PROBESIZE = cfg('FFMPEG_PROBESIZE', '10000000');
  FFMPEG_ANALYZEDURATION = cfg('FFMPEG_ANALYZEDURATION', '10000000');
  FFMPEG_TRANSCODE_PRESET = cfg('FFMPEG_TRANSCODE_PRESET', 'veryfast');
  HLS_SEGMENT_SECONDS = parseInt(cfg('HLS_SEGMENT_SECONDS', '2'), 10);
  HLS_LIST_SIZE = parseInt(cfg('HLS_LIST_SIZE', '4'), 10);
  enigmaBase = `http://${ENIGMA2_HOST}:${ENIGMA2_PORT}`;
  enigmaAuth = ENIGMA2_USER ? { username: ENIGMA2_USER, password: ENIGMA2_PASSWORD } : null;
  _piconDirCache = null;
}

// ─── TOTP helpers (RFC 6238) ─────────────────────────────────────────────────

function generateTotpSecret() {
  const buf = crypto.randomBytes(20);
  return base32Encode(buf);
}

function base32Encode(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    out += alphabet[parseInt(chunk, 2)];
  }
  return out;
}

function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of str.toUpperCase().replace(/=+$/, '')) {
    const idx = alphabet.indexOf(c);
    if (idx < 0) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpCode(secret, timeStep = 30, digits = 6) {
  const key = base32Decode(secret);
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / timeStep);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter & 0xffffffff, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % (10 ** digits);
  return String(code).padStart(digits, '0');
}

function verifyTotp(secret, token) {
  for (let i = -1; i <= 1; i++) {
    const epoch = Math.floor(Date.now() / 1000) + i * 30;
    const counter = Math.floor(epoch / 30);
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buf.writeUInt32BE(counter & 0xffffffff, 4);
    const key = base32Decode(secret);
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1000000;
    if (String(code).padStart(6, '0') === String(token).padStart(6, '0')) return true;
  }
  return false;
}

function saveConfig(updates) {
  const saved = loadSavedConfig();
  Object.assign(saved, updates);
  _savedConfig = null;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(saved, null, 2));
  applyConfig();
}

// Use a persistent path inside the container (not /tmp which Docker may flush)
const hlsRootDir = path.join(__dirname, '..', 'hls-sessions');
const hlsSessions = new Map();
// Clean up any leftover sessions from a previous crash/restart
try {
  fs.rmSync(hlsRootDir, { recursive: true, force: true });
} catch {}
try {
  fs.mkdirSync(hlsRootDir, { recursive: true });
} catch {}

app.use(compression({ filter: (req, res) => req.path !== '/api/logs' && compression.filter(req, res) }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  })
);

// ─── Setup routes ────────────────────────────────────────────────────────────

app.get('/setup', (req, res) => {
  if (!needsSetup) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.get('/api/setup/status', (req, res) => {
  res.json({ needsSetup });
});

app.get('/api/setup/defaults', (req, res) => {
  if (!needsSetup) return res.status(403).json({ error: 'Already configured' });
  const saved = loadSavedConfig();
  res.json({
    ENIGMA2_HOST:     saved.ENIGMA2_HOST     || '192.168.1.100',
    ENIGMA2_PORT:     saved.ENIGMA2_PORT     || '80',
    ENIGMA2_STREAM_PORT: saved.ENIGMA2_STREAM_PORT || '8001',
    ENIGMA2_SSH_PORT: saved.ENIGMA2_SSH_PORT || '22',
    ENIGMA2_USER:     saved.ENIGMA2_USER     || '',
    ENIGMA2_PASSWORD: saved.ENIGMA2_PASSWORD || '',
    APP_USERNAME:     saved.APP_USERNAME     || 'admin',
    APP_PASSWORD:     saved.APP_PASSWORD     || '',
    FFMPEG_FORCE_VIDEO_TRANSCODE: saved.FFMPEG_FORCE_VIDEO_TRANSCODE || 'false',
    FFMPEG_PROBESIZE: saved.FFMPEG_PROBESIZE || '10000000',
    FFMPEG_ANALYZEDURATION: saved.FFMPEG_ANALYZEDURATION || '10000000',
    FFMPEG_TRANSCODE_PRESET: saved.FFMPEG_TRANSCODE_PRESET || 'veryfast',
  });
});

app.post('/api/setup/save', (req, res) => {
  if (!needsSetup) return res.status(403).json({ error: 'Already configured' });
  const body = req.body || {};
  const config = {};
  const KEYS = [
    'ENIGMA2_HOST', 'ENIGMA2_PORT', 'ENIGMA2_STREAM_PORT', 'ENIGMA2_SSH_PORT',
    'ENIGMA2_USER', 'ENIGMA2_PASSWORD', 'ENIGMA2_STREAM_AUTH',
    'APP_USERNAME', 'APP_PASSWORD',
    'FFMPEG_FORCE_VIDEO_TRANSCODE', 'FFMPEG_PROBESIZE', 'FFMPEG_ANALYZEDURATION',
    'FFMPEG_TRANSCODE_PRESET',
  ];
  for (const k of KEYS) {
    if (body[k] !== undefined) config[k] = body[k];
  }
  if (!config.SESSION_SECRET) {
    config.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  }
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    return res.status(500).json({ error: 'Failed to write config: ' + e.message });
  }
  needsSetup = false;
  applyConfig();
  console.log('[setup] Configuration saved, app is ready');
  res.json({ ok: true });
});

app.post('/api/setup/test', async (req, res) => {
  const { host, port, user, password } = req.body || {};
  if (!host) return res.status(400).json({ error: 'Host required' });
  try {
    const url = `http://${host}:${port || 80}/api/about`;
    const config = { timeout: 8000 };
    if (user) config.auth = { username: user, password: password || '' };
    const resp = await axios.get(url, config);
    const info = resp.data?.info || {};
    res.json({ ok: true, model: info.model || '', image: info.imagever || '' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Auth middleware ──────────────────────────────────────────────────────────

const requireAuth = (req, res, next) => {
  if (needsSetup) return res.status(503).json({ error: 'Setup required' });
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.post('/auth/login', (req, res) => {
  if (needsSetup) return res.status(503).json({ error: 'Setup required' });
  const { username, password, totp } = req.body;
  if (username !== APP_USERNAME || password !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (APP_2FA_SECRET) {
    if (!totp) return res.json({ success: false, requires2fa: true });
    if (!verifyTotp(APP_2FA_SECRET, totp)) {
      return res.status(401).json({ error: 'Invalid 2FA code' });
    }
  }
  req.session.authenticated = true;
  res.json({ success: true });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/auth/check', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ─── App settings (authenticated) ────────────────────────────────────────────

app.get('/api/appsettings', requireAuth, (req, res) => {
  const saved = loadSavedConfig();
  res.json({
    ENIGMA2_HOST:     ENIGMA2_HOST,
    ENIGMA2_PORT:     String(ENIGMA2_PORT),
    ENIGMA2_STREAM_PORT: String(ENIGMA2_STREAM_PORT),
    ENIGMA2_SSH_PORT: String(ENIGMA2_SSH_PORT),
    ENIGMA2_USER:     ENIGMA2_USER,
    ENIGMA2_PASSWORD: ENIGMA2_PASSWORD,
    ENIGMA2_STREAM_AUTH: String(ENIGMA2_STREAM_AUTH),
    APP_USERNAME:     APP_USERNAME,
    FFMPEG_FORCE_VIDEO_TRANSCODE: String(FFMPEG_FORCE_VIDEO_TRANSCODE),
    FFMPEG_PROBESIZE: FFMPEG_PROBESIZE,
    FFMPEG_ANALYZEDURATION: FFMPEG_ANALYZEDURATION,
    FFMPEG_TRANSCODE_PRESET: FFMPEG_TRANSCODE_PRESET,
    HLS_SEGMENT_SECONDS: String(HLS_SEGMENT_SECONDS),
    HLS_LIST_SIZE: String(HLS_LIST_SIZE),
    has2fa: !!APP_2FA_SECRET,
  });
});

app.post('/api/appsettings', requireAuth, (req, res) => {
  const body = req.body || {};
  const updates = {};
  const KEYS = [
    'ENIGMA2_HOST', 'ENIGMA2_PORT', 'ENIGMA2_STREAM_PORT', 'ENIGMA2_SSH_PORT',
    'ENIGMA2_USER', 'ENIGMA2_PASSWORD', 'ENIGMA2_STREAM_AUTH',
    'FFMPEG_FORCE_VIDEO_TRANSCODE', 'FFMPEG_PROBESIZE', 'FFMPEG_ANALYZEDURATION',
    'FFMPEG_TRANSCODE_PRESET', 'HLS_SEGMENT_SECONDS', 'HLS_LIST_SIZE',
  ];
  for (const k of KEYS) {
    if (body[k] !== undefined) updates[k] = body[k];
  }
  try {
    saveConfig(updates);
    console.log('[settings] Configuration updated');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/appsettings/password', requireAuth, (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body;
  if (!currentPassword || currentPassword !== APP_PASSWORD) {
    return res.status(403).json({ error: 'Aktuelles Passwort falsch' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Neues Passwort zu kurz (min. 4 Zeichen)' });
  }
  const updates = { APP_PASSWORD: newPassword };
  if (newUsername && newUsername.trim()) updates.APP_USERNAME = newUsername.trim();
  try {
    saveConfig(updates);
    console.log('[settings] Password changed');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/appsettings/2fa/setup', requireAuth, (req, res) => {
  const secret = generateTotpSecret();
  const otpauthUrl = `otpauth://totp/E2StreamHub:${encodeURIComponent(APP_USERNAME)}?secret=${secret}&issuer=E2StreamHub&digits=6&period=30`;
  req.session._pending2faSecret = secret;
  res.json({ secret, otpauthUrl });
});

app.post('/api/appsettings/2fa/confirm', requireAuth, (req, res) => {
  const { token } = req.body;
  const secret = req.session._pending2faSecret;
  if (!secret) return res.status(400).json({ error: 'Kein 2FA-Setup aktiv' });
  if (!verifyTotp(secret, token)) {
    return res.status(400).json({ error: 'Ungültiger Code — bitte erneut versuchen' });
  }
  try {
    saveConfig({ APP_2FA_SECRET: secret });
    delete req.session._pending2faSecret;
    console.log('[settings] 2FA enabled');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/appsettings/2fa/disable', requireAuth, (req, res) => {
  const { password } = req.body;
  if (password !== APP_PASSWORD) return res.status(403).json({ error: 'Passwort falsch' });
  try {
    saveConfig({ APP_2FA_SECRET: '' });
    console.log('[settings] 2FA disabled');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Enigma2 proxy helper ─────────────────────────────────────────────────────

async function enigmaGet(apiPath, params = {}) {
  const config = { params, timeout: 15000, httpAgent: _keepAliveAgent };
  if (enigmaAuth) config.auth = enigmaAuth;
  const response = await axios.get(`${enigmaBase}${apiPath}`, config);
  return response.data;
}

// ─── Simple TTL cache for read-only Enigma2 API responses ────────────────────
const _apiCache = new Map(); // key → { data, expiresAt }

function cacheGet(key) {
  const entry = _apiCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _apiCache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data, ttlMs) {
  _apiCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}
function cacheDel(prefix) {
  for (const k of _apiCache.keys()) { if (k.startsWith(prefix)) _apiCache.delete(k); }
}

async function enigmaCached(apiPath, params = {}, ttlMs = 30000) {
  const key = apiPath + JSON.stringify(params);
  const hit = cacheGet(key);
  if (hit) return hit;
  const data = await enigmaGet(apiPath, params);
  cacheSet(key, data, ttlMs);
  return data;
}

// Extract the MPEG-TS program number from a service reference.
// Service reference format: 1:0:19:83:6:85:C00000:0:0:0:
// Field index 3 (0-based) is the service ID in hex → decimal = program number.
// Example: "83" hex = 131 decimal — matches #EXTVLCOPT:program=131 in M3U files.
function getProgramNumber(sRef) {
  const parts = sRef.split(':');
  if (parts.length >= 4) {
    const num = parseInt(parts[3], 16);
    if (!isNaN(num) && num > 0) return num;
  }
  return null;
}

function cleanupHlsSession(sessionId) {
  const sess = hlsSessions.get(sessionId);
  if (!sess) return;
  if (sess.ffmpeg && !sess.ffmpeg.killed) {
    sess.ffmpeg.kill('SIGTERM');
  }
  if (sess.cleanupTimer) clearTimeout(sess.cleanupTimer);
  hlsSessions.delete(sessionId);
  try {
    fs.rmSync(sess.dir, { recursive: true, force: true });
  } catch {}
}

function touchHlsSession(sessionId) {
  const sess = hlsSessions.get(sessionId);
  if (!sess) return;
  sess.lastSeen = Date.now();
  if (sess.cleanupTimer) clearTimeout(sess.cleanupTimer);
  sess.cleanupTimer = setTimeout(() => cleanupHlsSession(sessionId), 120000);
  // Delete segments no longer in the HLS window. We do this in Node.js (not via
  // ffmpeg's delete_segments flag) to avoid overlay-filesystem race conditions.
  try {
    const segs = fs.readdirSync(sess.dir)
      .filter(f => /^seg_\d+\.ts$/.test(f))
      .sort();
    const keep = HLS_LIST_SIZE + 2; // playlist window + small safety buffer
    segs.slice(0, Math.max(0, segs.length - keep)).forEach(f => {
      try { fs.unlinkSync(path.join(sess.dir, f)); } catch {}
    });
  } catch {}
}

function isRecordingSRef(sRef) {
  return /:\/.+\.\w+$/.test(sRef);
}

function buildSourceUrl(sRef) {
  const encoded = sRef.replace(/ /g, '%20');
  if (ENIGMA2_STREAM_AUTH && ENIGMA2_USER) {
    return `http://${encodeURIComponent(ENIGMA2_USER)}:${encodeURIComponent(ENIGMA2_PASSWORD)}@${ENIGMA2_HOST}:${ENIGMA2_STREAM_PORT}/${encoded}`;
  }
  return `http://${ENIGMA2_HOST}:${ENIGMA2_STREAM_PORT}/${encoded}`;
}

function buildHlsArgs(sourceUrl, programNum, outPlaylist) {
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+nobuffer+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-max_error_rate', '1.0',      // tolerate all decode errors; never crash on corrupt stream
    '-probesize', FFMPEG_PROBESIZE,
    '-analyzeduration', FFMPEG_ANALYZEDURATION,
    '-i', sourceUrl,
    '-ignore_unknown',             // suppress unknown private-data stream warnings
  ];

  if (programNum) {
    args.push('-map', `0:p:${programNum}:v:0?`);
    args.push('-map', `0:p:${programNum}:a:0?`);
  } else {
    args.push('-map', '0:v:0?', '-map', '0:a:0?');
  }

  args.push('-dn', '-sn');

  // HLS always requires transcoded video: copy-mode cannot guarantee keyframe
  // alignment or inject missing SPS/PPS when joining a live stream mid-GOP.
  // FFMPEG_FORCE_VIDEO_TRANSCODE controls the preset (quality/speed trade-off);
  // ultrafast is the default to keep latency and CPU load low.
  args.push(
    '-c:v', 'libx264',
    '-preset', FFMPEG_FORCE_VIDEO_TRANSCODE ? FFMPEG_TRANSCODE_PRESET : 'ultrafast',
    '-tune', 'zerolatency',
    '-g', '50',
    '-keyint_min', '25',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-ac', '2',
    '-ar', '48000',
    '-b:a', '128k'
  );

  // NOTE: do NOT use delete_segments — it causes race conditions on Docker's
  // overlay filesystem when ffmpeg deletes seg N while writing seg N+4.
  // Old segments are cleaned up by touchHlsSession() in Node.js instead.
  args.push(
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_SECONDS),
    '-hls_init_time', '0',
    '-hls_list_size', String(HLS_LIST_SIZE),
    '-hls_flags', 'append_list+omit_endlist',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(path.dirname(outPlaylist), 'seg_%06d.ts'),
    outPlaylist
  );

  return args;
}

// ─── API routes ───────────────────────────────────────────────────────────────

// 1×1 transparent PNG — returned instead of 404 so the browser never logs an error
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQ' +
  'AABjkB6QAAAABJRU5ErkJggg==', 'base64');

// In-memory set of sRefs that 404'd on the receiver (reset on server restart)
const _piconMissing = new Set();

// Proxy picon images from the receiver (avoids CORS + auth issues in browser)
app.get('/picon/:sref', requireAuth, async (req, res) => {
  const sendEmpty = () => {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.end(TRANSPARENT_PNG);
  };

  try {
    const raw = decodeURIComponent(req.params.sref);

    // For IPTV sRefs (5001/5002) strip the embedded URL and channel name —
    // picons are stored using only the first 10 colon-separated fields.
    const parts = raw.split(':');
    const firstType = parseInt(parts[0], 10);
    let sRefOnly;
    if (firstType === 5001 || firstType === 5002) {
      sRefOnly = parts.slice(0, 10).join(':');
    } else {
      // Strip embedded label (sRef may have "::Channel Name" appended)
      sRefOnly = raw.split('::')[0].replace(/:+$/, '');
    }

    // Skip sRefs we already know are missing
    if (_piconMissing.has(sRefOnly)) return sendEmpty();

    const name = sRefToPiconName(sRefOnly);
    const url  = `${enigmaBase}/picon/${name}.png`;
    const config = { responseType: 'stream', timeout: 5000 };
    if (enigmaAuth) config.auth = enigmaAuth;

    const response = await axios.get(url, config);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    response.data.pipe(res);
  } catch {
    // Fallback: try reading the picon from the detected picon directory via file API
    try {
      const raw = decodeURIComponent(req.params.sref);
      const parts = raw.split(':');
      const firstType = parseInt(parts[0], 10);
      let sRefOnly;
      if (firstType === 5001 || firstType === 5002) {
        sRefOnly = parts.slice(0, 10).join(':');
      } else {
        sRefOnly = raw.split('::')[0].replace(/:+$/, '');
      }
      const piconDir = await detectPiconDir();
      const filename = sRefToPiconName(sRefOnly) + '.png';
      const remotePath = `${piconDir.replace(/\/$/, '')}/${filename}`;
      const fileConfig = { params: { file: remotePath }, responseType: 'stream', timeout: 5000 };
      if (enigmaAuth) fileConfig.auth = enigmaAuth;
      const fileRes = await axios.get(`${enigmaBase}/file`, fileConfig);
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      fileRes.data.pipe(res);
    } catch {
      try {
        const raw = decodeURIComponent(req.params.sref);
        _piconMissing.add(raw.split('::')[0].replace(/:+$/, ''));
      } catch { /* ignore */ }
      sendEmpty();
    }
  }
});

// ─── Picon management ─────────────────────────────────────────────────────────

// Known picon directories on Enigma2 receivers (checked in order)
const KNOWN_PICON_DIRS = [
  '/usr/share/enigma2/picons',
  '/usr/share/enigma2/picons_hd',
  '/media/usb/picons',
  '/media/usb/picons_hd',
  '/media/hdd/picons',
  '/media/hdd/picons_hd',
  '/media/mmc/picons',
  '/tmp/picons',
];

// Convert sRef to picon filename matching Enigma2/PiconManager convention
// "1:0:1:d72a:1EC0:..." → "1_0_1_D72A_1EC0_0_0_0_0_0"
function sRefToPiconName(sRef) {
  const parts = String(sRef).replace(/:+$/, '').split(':');
  while (parts.length < 10) parts.push('0');
  return parts.slice(0, 10).map(p => /^[0-9a-fA-F]+$/.test(p) ? p.toUpperCase() : p).join('_');
}

// Auto-detect the best picon directory and cache the result
let _piconDirCache = null;

async function detectPiconDir() {
  if (_piconDirCache) return _piconDirCache;

  // 1. Try Enigma2 settings file for a configured path
  try {
    const settings = await enigmaReadFile('/etc/enigma2/settings');
    const m = settings.match(/config\.(?:DreamPlex\.piconpath|plugins\.piconcockpit\.iconpath|plugins\.piconmanager\.savetopath)\s*=\s*(.+)/);
    if (m) {
      const p = m[1].trim();
      if (p) { _piconDirCache = p; return p; }
    }
  } catch {}

  // 2. SSH scan of known directories — return first that exists
  if (ENIGMA2_USER) {
    let conn;
    try {
      conn = await sshConnect();
      const found = await new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
          if (err) { conn.end(); return reject(err); }
          let pending = KNOWN_PICON_DIRS.length;
          let result = null;
          KNOWN_PICON_DIRS.forEach(dir => {
            sftp.stat(dir, (statErr, attrs) => {
              if (!result && !statErr && attrs && attrs.isDirectory()) result = dir;
              if (--pending === 0) { conn.end(); resolve(result); }
            });
          });
        });
      });
      if (found) { _piconDirCache = found; return found; }
    } catch (e) {
      if (conn) try { conn.end(); } catch {}
      console.warn('[picondir] SSH scan failed:', e.message);
    }
  }

  // 3. Fallback to most common path
  const fallback = '/usr/share/enigma2/picons';
  _piconDirCache = fallback;
  return fallback;
}

// Upload a picon for a service — body: { sRef, imageBase64 }
app.post('/api/picon/upload', requireAuth, express.json({ limit: '2mb' }), async (req, res) => {
  const { sRef, imageBase64 } = req.body;
  if (!sRef || !imageBase64)
    return res.status(400).json({ error: 'Missing fields' });

  try {
    const piconDir  = await detectPiconDir();
    const filename  = sRefToPiconName(sRef) + '.png';
    const remotePath = `${piconDir.replace(/\/$/, '')}/${filename}`;

    const base64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    await sshWriteFile(remotePath, Buffer.from(base64, 'base64'));

    console.log('[picon/upload] saved to', remotePath);
    res.json({ ok: true, remotePath, filename, piconDir });
  } catch (e) {
    console.error('[picon/upload] error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/bouquets', requireAuth, async (req, res) => {
  try {
    const data = await enigmaCached('/api/bouquets', {}, 120000);
    res.json(data);
  } catch (err) {
    console.error('bouquets error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/services', requireAuth, async (req, res) => {
  try {
    const data = await enigmaCached('/api/getservices', { sRef: req.query.sRef }, 120000);
    res.json(data);
  } catch (err) {
    console.error('services error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/epg', requireAuth, async (req, res) => {
  try {
    const data = await enigmaCached('/api/epgservice', { sRef: req.query.sRef }, 30000);
    res.json(data);
  } catch (err) {
    console.error('epg error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/epgbouquet', requireAuth, async (req, res) => {
  try {
    const data = await enigmaCached('/api/epgbouquet', { bRef: req.query.bRef }, 30000);
    res.json(data);
  } catch (err) {
    console.error('epgbouquet error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Full event details including longdesc — used by the program info modal
app.get('/api/epgevent', requireAuth, async (req, res) => {
  try {
    const { eventid, sRef } = req.query;
    const data = await enigmaGet('/api/epgevent', { eventid, sRef });
    res.json(data);
  } catch (err) {
    console.error('epgevent error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ─── Bouquet Editor ───────────────────────────────────────────────────────────

// Extract file path from bouquet ref:
// "1:7:1:0:0:0:0:0:0:0:FROM BOUQUET \"userbouquet.xxx.tv\" ORDER BY bouquet"
function bouquetFilePath(bRef) {
  const m = String(bRef || '').match(/"([^"]+)"/);
  return m ? `/etc/enigma2/${m[1]}` : null;
}

// Reload Enigma2 service list so changes appear in OpenWebif and on the receiver.
// Tries HTTP endpoints first, then SSH exec as final fallback.
async function reloadEnigmaServices() {
  const httpPaths = [
    '/api/servicelistreload?mode=2',   // UserBouquets — correct endpoint per OpenWebif docs
    '/web/servicelistreload?mode=2',
    '/api/reloadservices',
    '/web/reloadservices',
  ];
  for (const path of httpPaths) {
    try {
      await enigmaGet(path);
      console.log('[reload] success via HTTP', path);
      return;
    } catch (err) {
      console.warn('[reload] failed via HTTP', path, '–', err.message);
    }
  }

  // SSH fallbacks
  if (ENIGMA2_USER) {
    // 1. Call OpenWebif from within the receiver (bypasses any network auth issues)
    for (const path of ['/api/servicelistreload?mode=2', '/web/servicelistreload?mode=2']) {
      try {
        const out = await sshExec(`curl -sf "http://localhost:${ENIGMA2_PORT}${path}"`);
        console.log('[reload] success via SSH curl localhost', path, out?.slice(0, 80));
        return;
      } catch (err) {
        console.warn('[reload] SSH curl localhost', path, 'failed –', err.message);
      }
    }

    // 2. Send SIGUSR1 to enigma2 — triggers service-list reload on many images
    try {
      await sshExec('kill -USR1 $(pidof enigma2)');
      console.log('[reload] success via SIGUSR1');
      return;
    } catch (err) {
      console.warn('[reload] SIGUSR1 failed –', err.message);
    }

    // 3. SIGHUP — some images use this for soft-reload
    try {
      await sshExec('kill -HUP $(pidof enigma2)');
      console.log('[reload] success via SIGHUP');
      return;
    } catch (err) {
      console.warn('[reload] SIGHUP failed –', err.message);
    }
  }

  console.error('[reload] all reload attempts failed – file was saved, restart Enigma2 manually to apply changes');
}

function sshExec(command) {
  return new Promise(async (resolve, reject) => {
    let conn;
    try { conn = await sshConnect(); } catch (e) { return reject(e); }
    conn.exec(command, (err, stream) => {
      if (err) { conn.end(); return reject(err); }
      let out = '';
      stream.on('data', d => { out += d; });
      stream.stderr.on('data', d => { out += d; });
      stream.on('close', code => {
        conn.end();
        if (code === 0) resolve(out.trim());
        else reject(new Error(`exit ${code}: ${out.trim()}`));
      });
    });
  });
}

// ─── SSH helpers (SFTP fallback when OpenWebif file API is unavailable) ───────

function sshConnect() {
  return new Promise((resolve, reject) => {
    if (!ENIGMA2_USER) {
      return reject(new Error('SSH nicht konfiguriert: ENIGMA2_USER fehlt'));
    }
    const conn = new SshClient();
    // Hard wall-clock timeout — ssh2's readyTimeout only covers the handshake,
    // not the TCP SYN phase, so the connection can hang much longer without this.
    const timer = setTimeout(() => {
      try { conn.end(); } catch {}
      reject(new Error(`SSH-Timeout (12 s): ${ENIGMA2_HOST}:${ENIGMA2_SSH_PORT} nicht erreichbar`));
    }, 12000);
    conn.on('ready', () => { clearTimeout(timer); resolve(conn); });
    conn.on('error', err => { clearTimeout(timer); reject(err); });
    conn.connect({
      host: ENIGMA2_HOST,
      port: ENIGMA2_SSH_PORT,
      username: ENIGMA2_USER,
      password: ENIGMA2_PASSWORD,
      readyTimeout: 10000,
      hostVerifier: () => true,   // local-network receiver, no CA needed
    });
  });
}

async function sshReadFile(remotePath) {
  const conn = await sshConnect();
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) { conn.end(); return reject(err); }
      const chunks = [];
      const stream = sftp.createReadStream(remotePath);
      stream.on('error', e => { conn.end(); reject(e); });
      stream.on('data',  c => chunks.push(c));
      stream.on('end',   () => { conn.end(); resolve(Buffer.concat(chunks).toString('utf8')); });
    });
  });
}

async function sshWriteFile(remotePath, content) {
  const conn = await sshConnect();
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) { conn.end(); return reject(err); }
      const dir = remotePath.substring(0, remotePath.lastIndexOf('/'));
      sftp.mkdir(dir, (mkdirErr) => {
        // Ignore EEXIST (dir already exists), fail on other errors only if write fails
        const buf    = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        const stream = sftp.createWriteStream(remotePath, { flags: 'w' });
        stream.on('error', e  => { conn.end(); reject(e); });
        stream.on('close', () => { conn.end(); resolve(); });
        stream.end(buf);
      });
    });
  });
}

async function enigmaReadFile(filePath) {
  // Try OpenWebif HTTP file API first
  try {
    const config = {
      params: { file: filePath },
      timeout: 10000,
      responseType: 'text',
      transformResponse: [d => d],
    };
    if (enigmaAuth) config.auth = enigmaAuth;
    const { data } = await axios.get(`${enigmaBase}/api/file`, config);
    return data;
  } catch (err) {
    if (err.response?.status !== 404 && err.response?.status !== 405) throw err;
  }
  // SSH fallback
  return await sshReadFile(filePath);
}

async function enigmaWriteFile(filePath, content) {
  // Try OpenWebif HTTP file API first
  try {
    const body   = new URLSearchParams({ filename: filePath, file: content }).toString();
    const config = { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 };
    if (enigmaAuth) config.auth = enigmaAuth;
    await axios.post(`${enigmaBase}/api/file`, body, config);
    return;
  } catch (err) {
    if (err.response?.status !== 404 && err.response?.status !== 405) throw err;
    console.warn('[enigmaWriteFile] HTTP file API unavailable, trying SSH');
  }
  // SSH fallback
  await sshWriteFile(filePath, content);
}

function parseBouquetFile(content) {
  const lines = content.split('\n');
  let name = '';
  const items = [];
  let seq = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#NAME ')) {
      name = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith('#SERVICE ')) continue;

    const sRef = line.slice(9).trim();
    let description = '';
    if (i + 1 < lines.length && lines[i + 1].trim().startsWith('#DESCRIPTION ')) {
      description = lines[i + 1].trim().slice(13).trim();
      i++;
    }

    const parts = sRef.split(':');
    const svcTypePart = (parts[1] || '').toLowerCase();
    const svcTypeNum  = parseInt(svcTypePart, 16);
    // 0x64 = numbered marker (most common), 0x832 = Enigma2 marker variant
    const isMarker    = svcTypeNum === 0x64 || svcTypeNum === 0x832;
    const isSubBouquet = sRef.toUpperCase().includes('FROM BOUQUET');
    const id = `i${++seq}_${Date.now()}`;

    if (isMarker) {
      // Label can be in #DESCRIPTION or embedded in sRef after "::"
      const embeddedLabel = sRef.includes('::') ? sRef.split('::').pop() : '';
      items.push({ type: 'marker', sRef, label: description || embeddedLabel, id });
    } else if (isSubBouquet) {
      items.push({ type: 'subbouquet', sRef, label: description, id });
    } else {
      items.push({ type: 'service', sRef, name: description, id });
    }
  }
  return { name, items };
}

function serializeBouquetFile(name, items) {
  let out = `#NAME ${name}\n`;
  let markerSeq = 0;
  for (const item of items) {
    let sRef = item.sRef;
    const label = item.type === 'service' ? (item.name || '') : (item.label || '');

    if (!sRef) {
      if (item.type === 'marker') {
        // Use the 0x64 marker format — embed label in the sRef as Enigma2 expects
        sRef = `1:64:${markerSeq++}:0:0:0:0:0:0:0::${label}`;
      } else {
        continue; // skip items without a valid sRef
      }
    } else if (item.type === 'marker' && !sRef.includes('::') && label) {
      // Existing marker sRef without embedded label — patch it in
      const base = sRef.replace(/:+$/, '');
      sRef = `${base}::${label}`;
    }

    out += `#SERVICE ${sRef}\n`;
    out += `#DESCRIPTION ${label}\n`;
  }
  return out;
}

app.get('/api/bouquetedit', requireAuth, async (req, res) => {
  const bRef = req.query.bRef || '';
  const filePath = bouquetFilePath(bRef);
  if (!filePath) return res.status(400).json({ error: 'Invalid bouquet reference' });

  // Try to read the actual bouquet file (HTTP → SSH → services fallback)
  try {
    const content = await enigmaReadFile(filePath);
    const parsed  = parseBouquetFile(content);

    // Some bouquet files have #SERVICE lines but no #DESCRIPTION lines.
    // Fill in missing service names from the OpenWebif services API.
    const unnamed = parsed.items.filter(i => i.type === 'service' && !i.name);
    if (unnamed.length > 0) {
      try {
        const svcData = await enigmaGet('/api/getservices', { sRef: bRef });
        const nameMap = new Map((svcData.services || []).map(s => [s.servicereference, s.servicename]));
        parsed.items.forEach(item => {
          if (item.type === 'service' && !item.name) {
            item.name = nameMap.get(item.sRef) || item.sRef;
          }
        });
      } catch { /* leave sRef as fallback label */ }
    }

    return res.json({ ...parsed, filePath });
  } catch (readErr) {
    console.warn('[bouquetedit] file read failed:', readErr.message, '– reconstructing from getservices');
  }

  // Last resort: reconstruct from services list (markers not preserved)
  try {
    const svcData  = await enigmaGet('/api/getservices', { sRef: bRef });
    const services = svcData.services || [];
    const name     = filePath.split('/').pop().replace(/^userbouquet\./, '').replace(/\.[^.]+$/, '');
    const items    = services.map((svc, i) => ({
      type: 'service', sRef: svc.servicereference, name: svc.servicename, id: `i${i + 1}`,
    }));
    return res.json({ name, items, filePath, noFileAccess: true });
  } catch (err2) {
    return res.status(502).json({ error: err2.message });
  }
});

app.post('/api/bouquetedit', requireAuth, async (req, res) => {
  const { filePath, name, items } = req.body;
  if (!filePath || !name || !Array.isArray(items))
    return res.status(400).json({ error: 'Missing fields' });
  if (!filePath.startsWith('/etc/enigma2/'))
    return res.status(403).json({ error: 'Invalid path' });
  try {
    await enigmaWriteFile(filePath, serializeBouquetFile(name, items));
    await reloadEnigmaServices();
    res.json({ ok: true });
  } catch (err) {
    console.error('[bouquetedit] write error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/createbouquet', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Missing bouquet name' });

  const slug     = name.trim().toLowerCase()
    .replace(/[äöü]/g, c => ({ ä: 'ae', ö: 'oe', ü: 'ue' }[c] || ''))
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '').slice(0, 16) || 'bq';
  const filename = `userbouquet.${slug}${Date.now().toString(36)}.tv`;
  const filePath = `/etc/enigma2/${filename}`;
  const bRef     = `1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "${filename}" ORDER BY bouquet`;

  try {
    await enigmaWriteFile(filePath, `#NAME ${name.trim()}\n`);
    // Register in bouquets.tv
    try {
      let master = await enigmaReadFile('/etc/enigma2/bouquets.tv');
      master += `#SERVICE ${bRef}\n#DESCRIPTION ${name.trim()}\n`;
      await enigmaWriteFile('/etc/enigma2/bouquets.tv', master);
    } catch (e) {
      console.warn('[createbouquet] bouquets.tv update failed:', e.message);
    }
    reloadEnigmaServices();
    res.json({ ok: true, bRef, name: name.trim(), filePath });
  } catch (err) {
    console.error('[createbouquet] error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/statusinfo', requireAuth, async (req, res) => {
  try {
    const data = await enigmaCached('/api/statusinfo', {}, 10000);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── Receiver Settings / Control ────────────────────────────────────────────

app.get('/api/about', requireAuth, async (req, res) => {
  try {
    const data = await enigmaCached('/api/about', {}, 300000);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/signal', requireAuth, async (req, res) => {
  try {
    const data = await enigmaGet('/api/signal');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/vol', requireAuth, async (req, res) => {
  try {
    const params = {};
    if (req.query.set !== undefined) params.set = req.query.set;
    const data = await enigmaGet('/api/vol', params);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/powerstate', requireAuth, async (req, res) => {
  try {
    const params = {};
    if (req.query.newstate !== undefined) params.newstate = req.query.newstate;
    const data = await enigmaGet('/api/powerstate', params);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/message', requireAuth, async (req, res) => {
  try {
    const { text, type, timeout } = req.query;
    const data = await enigmaGet('/api/message', { text, type: type || '1', timeout: timeout || '10' });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/timerlist', requireAuth, async (req, res) => {
  try {
    const data = await enigmaGet('/api/timerlist');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/deviceinfo', requireAuth, async (req, res) => {
  try {
    const data = await enigmaGet('/api/deviceinfo');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/remotecontrol', requireAuth, async (req, res) => {
  try {
    const { command } = req.query;
    if (!command) return res.status(400).json({ error: 'Missing command' });
    const data = await enigmaGet('/api/remotecontrol', { command });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/getallservices', requireAuth, async (req, res) => {
  try {
    const data = await enigmaGet('/api/getallservices');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/timerdelete', requireAuth, async (req, res) => {
  try {
    const { sRef, begin, end } = req.query;
    const data = await enigmaGet('/api/timerdelete', { sRef, begin, end });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/timertoggle', requireAuth, async (req, res) => {
  try {
    const { sRef, begin, end } = req.query;
    const data = await enigmaGet('/api/timertoggle', { sRef, begin, end });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/timercleanup', requireAuth, async (req, res) => {
  try {
    const data = await enigmaGet('/api/timercleanup');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/recordings', requireAuth, async (req, res) => {
  try {
    const data = await enigmaGet('/api/movielist');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Stream a recording via fMP4 — takes the file path, not sRef
app.get('/stream-recording', requireAuth, async (req, res) => {
  const filePath = req.query.file || '';
  if (!filePath) return res.status(400).json({ error: 'Missing file parameter' });

  // Build the source URL: use OpenWebif /file endpoint to read the .ts file
  const authPart = ENIGMA2_USER && enigmaAuth
    ? `${encodeURIComponent(ENIGMA2_USER)}:${encodeURIComponent(ENIGMA2_PASSWORD)}@`
    : '';
  const sourceUrl = `http://${authPart}${ENIGMA2_HOST}:${ENIGMA2_PORT}/file?file=${encodeURIComponent(filePath)}`;

  console.log(`Recording stream: ${filePath}`);
  console.log(`Recording source URL: ${sourceUrl}`);

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  const ffArgs = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-max_error_rate', '1.0',
    '-probesize', FFMPEG_PROBESIZE,
    '-analyzeduration', FFMPEG_ANALYZEDURATION,
    '-i', sourceUrl,
    '-ignore_unknown',
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-dn', '-sn',
    '-c:v', 'libx264',
    '-preset', FFMPEG_FORCE_VIDEO_TRANSCODE ? FFMPEG_TRANSCODE_PRESET : 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'high', '-level:v', '4.0',
    '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
    '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '128k',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];

  const ff = spawn('ffmpeg', ffArgs);
  ff.stdout.pipe(res);

  let stderrBuf = '';
  ff.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) { stderrBuf += msg + '\n'; console.error(`ffmpeg(rec): ${msg}`); }
  });

  ff.on('close', code => {
    if (code && code !== 0 && !res.writableEnded) {
      console.error(`ffmpeg(rec) exited ${code}`);
    }
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => {
    ff.kill('SIGTERM');
  });
});

app.get('/api/current', requireAuth, async (req, res) => {
  try {
    const data = await enigmaGet('/api/subservices');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/sleeptimer', requireAuth, async (req, res) => {
  try {
    const params = {};
    if (req.query.cmd !== undefined) params.cmd = req.query.cmd;
    if (req.query.time !== undefined) params.time = req.query.time;
    if (req.query.action !== undefined) params.action = req.query.action;
    if (req.query.enabled !== undefined) params.enabled = req.query.enabled;
    const data = await enigmaGet('/api/sleeptimer', params);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const data = await enigmaGet('/api/settings');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/setsetting', requireAuth, async (req, res) => {
  try {
    const { key, value } = req.query;
    if (!key) return res.status(400).json({ error: 'Missing key' });
    const data = await enigmaGet('/api/setsetting', { key, value });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/hls/start', requireAuth, async (req, res) => {
  try {
    const sRef = String(req.body?.sRef || '');
    if (!sRef) return res.status(400).json({ error: 'Missing service reference' });

    const decodedSRef = decodeURIComponent(sRef);
    const isRec = isRecordingSRef(decodedSRef);
    const programNum = isRec ? null : getProgramNumber(decodedSRef);
    const sessionId = crypto.randomUUID();
    fs.mkdirSync(hlsRootDir, { recursive: true });
    const sessionDir = path.join(hlsRootDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const playlistPath = path.join(sessionDir, 'index.m3u8');

    const sourceUrl = buildSourceUrl(decodedSRef);
    const ffArgs = buildHlsArgs(sourceUrl, programNum, playlistPath);
    console.log(`hls start: ${decodedSRef} program=${programNum} session=${sessionId}`);

    const ff = spawn('ffmpeg', ffArgs);
    ff.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error(`ffmpeg(hls): ${msg}`);
    });
    ff.on('close', (code, signal) => {
      if (code && code !== 255) console.error(`ffmpeg(hls) exited: code=${code} signal=${signal} session=${sessionId}`);
      cleanupHlsSession(sessionId);
    });

    hlsSessions.set(sessionId, {
      ffmpeg: ff,
      dir: sessionDir,
      playlistPath,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      cleanupTimer: null,
    });
    touchHlsSession(sessionId);

    // Wait until the playlist AND the first segment exist — ensures Safari/iOS can
    // immediately start buffering instead of getting a 202 "warming up" response.
    const seg0Path = path.join(sessionDir, 'seg_000000.ts');
    const deadline = Date.now() + 20000;
    let clientGone = false;
    req.on('close', () => { clientGone = true; });

    while (Date.now() < deadline && !clientGone) {
      if (fs.existsSync(playlistPath) && fs.existsSync(seg0Path)) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    if (clientGone) {
      cleanupHlsSession(sessionId);
      return;
    }

    if (!fs.existsSync(playlistPath)) {
      cleanupHlsSession(sessionId);
      return res.status(503).json({ error: 'Stream did not start in time — channel may be unavailable' });
    }

    return res.json({
      sessionId,
      playlist: `/hls/${sessionId}/index.m3u8`,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/hls/stop', requireAuth, (req, res) => {
  const sessionId = String(req.body?.sessionId || '');
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  cleanupHlsSession(sessionId);
  return res.json({ success: true });
});

app.get('/hls/:sessionId/:file', requireAuth, (req, res) => {
  const { sessionId, file } = req.params;
  const sess = hlsSessions.get(sessionId);
  if (!sess) return res.status(404).end();
  if (file.includes('..') || file.includes('/') || file.includes('\\')) return res.status(400).end();

  touchHlsSession(sessionId);

  const target = path.join(sess.dir, file);
  if (!target.startsWith(sess.dir)) return res.status(400).end();

  if (!fs.existsSync(target)) {
    if (file === 'index.m3u8') {
      return res.status(202).type('text/plain').send('warming up');
    }
    return res.status(404).end();
  }

  if (file.endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store');
  } else if (file.endsWith('.ts')) {
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache, no-store');
  }

  return res.sendFile(target);
});

// ─── Stream proxy ─────────────────────────────────────────────────────────────
// Strategy:
//  1. For IPTV sRefs (type 5001/5002), extract the HTTP URL embedded in the sRef
//     directly — no need to ask the receiver at all.
//  2. Ask OpenWebif for the stream URL via /web/stream.m3u — this gives the
//     correct single-program URL (e.g. port 17999) that already has program
//     selection done server-side. Proxy it directly (no ffmpeg needed).
//  3. Fall back to ffmpeg extracting the program from the raw MPTS on port 8001.

// Extract the direct stream URL embedded in an IPTV sRef (type 5001/5002).
// sRef format: "5002:0:1:0:SID:TID:0:0:0:0:http://host/path:Channel Name"
// Split on ':' gives [..., 'http', '//host/path', 'Channel Name']
// so the URL is parts[10] + ':' + parts[11].
// The scheme may also be percent-encoded as 'http%3a' or 'https%3a'.
function extractIptvUrl(sRef) {
  // Fully decode the sRef first — it may arrive double-encoded (e.g. http%3a → http:)
  let decoded;
  try { decoded = decodeURIComponent(sRef); } catch { decoded = sRef; }
  const parts = decoded.split(':');
  const type = parseInt(parts[0], 10);
  if (type !== 5001 && type !== 5002) return null;
  // parts[10] = 'http' or 'https', parts[11] = '//host/path'
  if (parts.length > 11) {
    const scheme = parts[10].toLowerCase().replace(/%3a$/, '');
    if (scheme === 'http' || scheme === 'https') {
      return scheme + ':' + parts[11];
    }
  }
  return null;
}

async function resolveSptsUrl(sRef) {
  try {
    const config = { params: { ref: sRef }, responseType: 'text', timeout: 5000 };
    if (enigmaAuth) config.auth = enigmaAuth;
    const response = await axios.get(`${enigmaBase}/web/stream.m3u`, config);
    const m3u = response.data || '';
    for (const line of m3u.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        // Receiver appends ":Channel Name" after the stream URL.
        // Keep only up to the last known stream extension (.ts, .m3u8, etc.).
        const rawUrl = trimmed.replace(/^(https?:\/\/\S+?\.(ts|m3u8|mp4|mkv|avi)).*$/i, '$1');
        const url = new URL(rawUrl);
        const port = url.port || '80';
        const resolved = `http://${ENIGMA2_HOST}:${port}${url.pathname}`;
        console.log(`stream.m3u resolved: ${resolved}`);
        return resolved;
      }
    }
  } catch (e) {
    console.warn('stream.m3u lookup failed:', e.message);
  }
  return null;
}

app.get('/stream', requireAuth, async (req, res) => {
  const sRef = req.query.sRef || '';
  if (!sRef) return res.status(400).json({ error: 'Missing service reference' });

  const isRec = isRecordingSRef(sRef);
  const programNum = isRec ? null : getProgramNumber(sRef);
  console.log(`Stream request: ${sRef}  recording=${isRec}  program=${programNum}`);

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  let sourceUrl;

  if (isRec) {
    sourceUrl = buildSourceUrl(sRef);
  } else {
    const iptvUrl = extractIptvUrl(sRef);
    const sptsUrl = iptvUrl || await resolveSptsUrl(sRef);

    let canDirectRelay = false;
    if (sptsUrl) {
      try {
        const parsed = new URL(sptsUrl);
        const relayPort = parseInt(parsed.port || '80', 10);
        canDirectRelay = relayPort !== ENIGMA2_STREAM_PORT;
        if (!canDirectRelay) {
          console.log(`Skipping direct relay for port ${relayPort}; using ffmpeg program mapping`);
        }
      } catch {
        canDirectRelay = false;
      }
    }

    if (sptsUrl && canDirectRelay) {
      try {
        const axiosConfig = { responseType: 'stream', timeout: 10000 };
        if (enigmaAuth) axiosConfig.auth = enigmaAuth;
        const upstream = await axios.get(sptsUrl, axiosConfig);
        console.log(`Proxying SPTS from ${sptsUrl}  HTTP ${upstream.status}`);
        upstream.data.pipe(res);
        upstream.data.on('error', () => { if (!res.writableEnded) res.end(); });
        req.on('close', () => upstream.data.destroy());
        return;
      } catch (e) {
        console.warn('SPTS proxy failed, falling back to ffmpeg:', e.message);
      }
    }

    sourceUrl = buildSourceUrl(sRef);
  }

  console.log(`ffmpeg fallback: ${sourceUrl}  program=${programNum}`);

  const ffArgs = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+nobuffer+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-probesize', FFMPEG_PROBESIZE,
    '-analyzeduration', FFMPEG_ANALYZEDURATION,
    '-i', sourceUrl,
  ];

  if (programNum) {
    ffArgs.push('-map', `0:p:${programNum}:v:0?`);
    ffArgs.push('-map', `0:p:${programNum}:a:0?`);
  } else {
    ffArgs.push('-map', '0:v:0?', '-map', '0:a:0?');
  }

  ffArgs.push(
    '-dn',
    '-sn',
  );

  if (FFMPEG_FORCE_VIDEO_TRANSCODE) {
    ffArgs.push(
      '-c:v', 'libx264',
      '-preset', FFMPEG_TRANSCODE_PRESET,
      '-tune', 'zerolatency',
      '-g', '50',
      '-keyint_min', '50',
      '-x264-params', 'scenecut=0:open_gop=0',
      '-c:a', 'aac',
      '-ac', '2',
      '-ar', '48000',
      '-b:a', '128k'
    );
  } else {
    ffArgs.push(
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-ac', '2',
      '-ar', '48000',
      '-b:a', '128k'
    );
  }

  ffArgs.push(
    '-ignore_unknown',
    '-f', 'mpegts',
    '-mpegts_flags', '+resend_headers',
    '-avoid_negative_ts', 'make_zero',
    'pipe:1',
  );

  const ff = spawn('ffmpeg', ffArgs);

  ff.stdout.pipe(res);

  ff.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`ffmpeg: ${msg}`);
  });

  ff.on('error', (err) => {
    console.error('ffmpeg spawn error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Stream processing failed' });
    else if (!res.writableEnded) res.end();
  });

  ff.on('close', (code) => {
    if (code && code !== 255) console.log(`ffmpeg exited: code ${code}`);
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => ff.kill('SIGTERM'));
});

// ─── Fragmented MP4 stream ────────────────────────────────────────────────────
// Always transcodes to H.264+AAC and outputs fragmented MP4 via stdout pipe.
// No files on disk, no session management — the browser consumes it via MSE.
// Supported on all modern browsers including iOS Safari 13+ (MSE).

// Settle chain for fMP4 streams.
// Each request waits for the previous one's kill+settle to complete before
// spawning its own ffmpeg. This prevents the receiver's stream port from being
// held by the old process when the new connection arrives.
// resolveMySettle() is called only AFTER registering the new process in the Map
// so that a concurrent request always sees — and can kill — the latest process.
let fmp4LastSettle = Promise.resolve();
const activeFmp4Streams = new Map(); // sRef -> ChildProcess

app.get('/stream-fmp4', requireAuth, async (req, res) => {
  const sRef = req.query.sRef || '';
  if (!sRef) return res.status(400).json({ error: 'Missing service reference' });

  // Insert ourselves into the settle chain.
  let resolveMySettle;
  const mySettle = new Promise(r => { resolveMySettle = r; });
  const prevSettle = fmp4LastSettle;
  fmp4LastSettle = mySettle;

  // Wait for the previous request's kill+settle to finish.
  await prevSettle;

  // Bail early if the client navigated away while waiting.
  if (req.socket.destroyed) { resolveMySettle(); return; }

  // Kill every active fMP4 process (there should only ever be one).
  // Guard against the 'close' event having already fired before we register the
  // listener — if it has, exitCode/signalCode are non-null and we resolve immediately.
  // Without this check the settle chain would deadlock and block all future streams.
  let killed = false;
  for (const [key, ff] of [...activeFmp4Streams.entries()]) {
    ff.kill('SIGTERM');
    activeFmp4Streams.delete(key);
    await new Promise(r => {
      if (ff.exitCode !== null || ff.signalCode !== null) { r(); return; }
      const guard = setTimeout(r, 3000); // safety net — never block longer than 3 s
      ff.once('close', () => { clearTimeout(guard); r(); });
    });
    killed = true;
  }
  // Give the receiver time to close its HTTP connection before we reconnect.
  if (killed) await new Promise(r => setTimeout(r, 300));

  const isRecording = isRecordingSRef(sRef);
  const iptvUrl = extractIptvUrl(sRef);
  const programNum = (iptvUrl || isRecording) ? null : getProgramNumber(sRef);
  console.log(`fMP4 stream: ${sRef}  recording=${isRecording}  program=${programNum}`);

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  let sourceUrl;
  try {
    if (iptvUrl) {
      sourceUrl = iptvUrl;
    } else if (isRecording) {
      sourceUrl = buildSourceUrl(sRef);
    } else {
      const sptsUrl = await resolveSptsUrl(sRef);
      sourceUrl = buildSourceUrl(sRef);
      if (sptsUrl) {
        try {
          const parsed = new URL(sptsUrl);
          if (parseInt(parsed.port || '80', 10) !== ENIGMA2_STREAM_PORT) {
            sourceUrl = sptsUrl;
          }
        } catch {}
      }
    }
  } catch (err) {
    resolveMySettle();
    return res.status(502).json({ error: 'Failed to resolve stream URL' });
  }

  const ffArgs = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+genpts+discardcorrupt' + (isRecording ? '' : '+nobuffer'),
    '-err_detect', 'ignore_err',
    '-max_error_rate', '1.0',
    '-probesize', isRecording ? FFMPEG_PROBESIZE : '500000',
    '-analyzeduration', isRecording ? FFMPEG_ANALYZEDURATION : '500000',
  ];
  if (!isRecording) ffArgs.push('-flags', 'low_delay', '-thread_queue_size', '512');
  ffArgs.push('-i', sourceUrl, '-ignore_unknown');

  if (programNum) {
    ffArgs.push('-map', `0:p:${programNum}:v:0?`);
    ffArgs.push('-map', `0:p:${programNum}:a:0?`);
  } else {
    ffArgs.push('-map', '0:v:0?', '-map', '0:a:0?');
  }

  ffArgs.push(
    '-dn', '-sn',
    '-c:v', 'libx264',
    '-preset', FFMPEG_FORCE_VIDEO_TRANSCODE ? FFMPEG_TRANSCODE_PRESET : 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'high', '-level:v', '4.0',
    '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
    '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '128k',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  );

  // Retry loop: if the receiver is still closing the previous connection it
  // returns a tiny body immediately (exit 251 / "Stream ends prematurely").
  // Retry up to 4 times with increasing delays before giving up.
  let clientGone = false;
  req.on('close', () => { clientGone = true; });

  let settleResolved = false;
  const MAX_RETRIES = 4;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (clientGone || res.writableEnded) {
      if (!settleResolved) { settleResolved = true; resolveMySettle(); }
      break;
    }

    if (attempt > 0) {
      const delay = attempt * 500; // 500, 1000, 1500, 2000 ms
      console.log(`fMP4 retry ${attempt}/${MAX_RETRIES} for ${sRef} after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      if (clientGone || res.writableEnded) break;
    }

    const ff = spawn('ffmpeg', ffArgs);
    activeFmp4Streams.set(sRef, ff);
    if (!settleResolved) { settleResolved = true; resolveMySettle(); } // Unblock next queued request

    ff.stdout.pipe(res, { end: false });

    let stderrBuf = '';
    ff.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) { stderrBuf += msg + '\n'; console.error(`ffmpeg(fmp4): ${msg}`); }
    });

    const exitCode = await new Promise(resolve => {
      ff.on('error', err => {
        console.error('ffmpeg(fmp4) spawn error:', err.message);
        resolve(-1);
      });
      ff.on('close', resolve);
      req.once('close', () => ff.kill('SIGTERM'));
    });

    activeFmp4Streams.delete(sRef);

    // Exit 255 = SIGTERM (normal stop by client or channel switch) → don't retry
    if (exitCode === 255 || clientGone || res.writableEnded) break;

    // Exit 251 = ffmpeg I/O error (receiver not ready) → retry
    if (exitCode === 251) continue;

    // Any other non-zero exit after producing data → done
    if (exitCode && exitCode !== 0) {
      console.log(`ffmpeg(fmp4) exited: ${exitCode}`);
      break;
    }

    // Clean exit (0) or data flowed normally → done
    break;
  }

  if (!res.writableEnded) res.end();
});

// ─── Live log SSE endpoint ───────────────────────────────────────────────────
app.get('/api/logs', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  logClients.add(res);
  req.on('close', () => logClients.delete(res));
});

// ─── Picon directory lookup ──────────────────────────────────────────────────
app.get('/api/picondir', requireAuth, async (req, res) => {
  try {
    const dir = await detectPiconDir();
    res.json({ path: dir });
  } catch (e) {
    res.json({ path: '/usr/share/enigma2/picon' });
  }
});

// ─── SFTP File Browser API ───────────────────────────────────────────────────

app.get('/api/files/ls', requireAuth, async (req, res) => {
  const dir = req.query.path || '/';
  let conn;
  try {
    conn = await sshConnect();
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, s) => err ? reject(err) : resolve(s));
    });
    const list = await new Promise((resolve, reject) => {
      sftp.readdir(dir, (err, items) => err ? reject(err) : resolve(items));
    });
    conn.end();
    const entries = list
      .filter(i => i.filename !== '.' && i.filename !== '..')
      .map(i => ({
        name: i.filename,
        isDir: (i.attrs.mode & 0o40000) !== 0,
        size: i.attrs.size,
        mtime: i.attrs.mtime,
        mode: '0' + (i.attrs.mode & 0o7777).toString(8),
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ path: dir, entries });
  } catch (e) {
    if (conn) try { conn.end(); } catch {}
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/files/read', requireAuth, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const content = await sshReadFile(filePath);
    res.json({ path: filePath, content });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/files/write', requireAuth, async (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    await sshWriteFile(filePath, content || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/files/mkdir', requireAuth, async (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'path required' });
  try {
    await sshExec(`mkdir -p "${dirPath}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/files/delete', requireAuth, async (req, res) => {
  const { path: targetPath } = req.body;
  if (!targetPath || targetPath === '/') return res.status(400).json({ error: 'invalid path' });
  try {
    await sshExec(`rm -rf "${targetPath}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/files/rename', requireAuth, async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  try {
    await sshExec(`mv "${from}" "${to}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/files/copy', requireAuth, async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  try {
    await sshExec(`cp -r "${from}" "${to}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/files/download', requireAuth, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  let conn;
  try {
    conn = await sshConnect();
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, s) => err ? reject(err) : resolve(s));
    });
    const basename = filePath.split('/').pop();
    res.setHeader('Content-Disposition', `attachment; filename="${basename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    const stream = sftp.createReadStream(filePath);
    stream.on('error', e => { conn.end(); if (!res.headersSent) res.status(502).json({ error: e.message }); });
    stream.on('end', () => conn.end());
    stream.pipe(res);
  } catch (e) {
    if (conn) try { conn.end(); } catch {}
    res.status(502).json({ error: e.message });
  }
});

// ─── SSH Command execution ───────────────────────────────────────────────────
app.post('/api/ssh/exec', requireAuth, async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    const output = await sshExec(command);
    res.json({ ok: true, output: output || '(no output)' });
  } catch (e) {
    const msg = e.message || String(e);
    res.json({ ok: false, output: msg });
  }
});

// ─── Static files & SPA fallback ─────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (needsSetup && req.path !== '/setup') return res.redirect('/setup');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

const WebSocket = require('ws');

const server = app.listen(PORT, () => {
  console.log(`E2StreamHub running on http://0.0.0.0:${PORT}`);
  console.log(`Enigma2 receiver: ${enigmaBase}`);
});

// ─── WebSocket SSH Terminal ──────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws/ssh' });

wss.on('connection', (ws, req) => {
  if (!ENIGMA2_USER) {
    ws.send(JSON.stringify({ type: 'error', data: 'SSH not configured (ENIGMA2_USER missing)' }));
    ws.close();
    return;
  }

  const conn = new SshClient();
  let shell = null;

  const timer = setTimeout(() => {
    try { conn.end(); } catch {}
    ws.send(JSON.stringify({ type: 'error', data: 'SSH connection timeout' }));
    ws.close();
  }, 12000);

  conn.on('ready', () => {
    clearTimeout(timer);
    conn.shell({ term: 'xterm-256color', cols: 120, rows: 30 }, (err, stream) => {
      if (err) {
        ws.send(JSON.stringify({ type: 'error', data: err.message }));
        conn.end();
        ws.close();
        return;
      }
      shell = stream;
      ws.send(JSON.stringify({ type: 'connected' }));

      stream.on('data', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data: data.toString('utf8') }));
        }
      });
      stream.on('close', () => {
        conn.end();
        if (ws.readyState === WebSocket.OPEN) ws.close();
      });
    });
  });

  conn.on('error', (err) => {
    clearTimeout(timer);
    ws.send(JSON.stringify({ type: 'error', data: err.message }));
    ws.close();
  });

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'data' && shell) {
        shell.write(parsed.data);
      } else if (parsed.type === 'resize' && shell) {
        shell.setWindow(parsed.rows, parsed.cols, 0, 0);
      }
    } catch {}
  });

  ws.on('close', () => {
    clearTimeout(timer);
    if (shell) try { shell.end(); } catch {}
    try { conn.end(); } catch {}
  });

  conn.connect({
    host: ENIGMA2_HOST,
    port: ENIGMA2_SSH_PORT,
    username: ENIGMA2_USER,
    password: ENIGMA2_PASSWORD,
    readyTimeout: 10000,
    hostVerifier: () => true,
  });
});
