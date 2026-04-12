const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

const ENIGMA2_HOST = process.env.ENIGMA2_HOST || '192.168.1.100';
const ENIGMA2_PORT = parseInt(process.env.ENIGMA2_PORT || '80', 10);
const ENIGMA2_STREAM_PORT = parseInt(process.env.ENIGMA2_STREAM_PORT || '8001', 10);
const ENIGMA2_USER = process.env.ENIGMA2_USER || '';
const ENIGMA2_PASSWORD = process.env.ENIGMA2_PASSWORD || '';
const APP_USERNAME = process.env.APP_USERNAME || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'e2streamhub-change-this-secret';
const FFMPEG_FORCE_VIDEO_TRANSCODE = String(process.env.FFMPEG_FORCE_VIDEO_TRANSCODE || '').toLowerCase() === 'true';

const enigmaBase = `http://${ENIGMA2_HOST}:${ENIGMA2_PORT}`;
const enigmaAuth = ENIGMA2_USER
  ? { username: ENIGMA2_USER, password: ENIGMA2_PASSWORD }
  : null;

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

// ─── Auth middleware ──────────────────────────────────────────────────────────

const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (username === APP_USERNAME && password === APP_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/auth/check', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ─── Enigma2 proxy helper ─────────────────────────────────────────────────────

async function enigmaGet(apiPath, params = {}) {
  const config = { params, timeout: 15000 };
  if (enigmaAuth) config.auth = enigmaAuth;
  const response = await axios.get(`${enigmaBase}${apiPath}`, config);
  return response.data;
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

// ─── API routes ───────────────────────────────────────────────────────────────

app.get('/api/bouquets', requireAuth, async (req, res) => {
  try {
    const data = await enigmaGet('/api/bouquets');
    res.json(data);
  } catch (err) {
    console.error('bouquets error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/services', requireAuth, async (req, res) => {
  try {
    const data = await enigmaGet('/api/getservices', { sRef: req.query.sRef });
    res.json(data);
  } catch (err) {
    console.error('services error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/epg', requireAuth, async (req, res) => {
  try {
    const data = await enigmaGet('/api/epgservice', { sRef: req.query.sRef });
    res.json(data);
  } catch (err) {
    console.error('epg error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/epgbouquet', requireAuth, async (req, res) => {
  try {
    const data = await enigmaGet('/api/epgbouquet', { bRef: req.query.bRef });
    res.json(data);
  } catch (err) {
    console.error('epgbouquet error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/statusinfo', requireAuth, async (req, res) => {
  try {
    const data = await enigmaGet('/api/statusinfo');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── Stream proxy ─────────────────────────────────────────────────────────────
// Strategy:
//  1. Ask OpenWebif for the stream URL via /web/stream.m3u — this gives the
//     correct single-program URL (e.g. port 17999) that already has program
//     selection done server-side. Proxy it directly (no ffmpeg needed).
//  2. Fall back to ffmpeg extracting the program from the raw MPTS on port 8001.

async function resolveSptsUrl(sRef) {
  try {
    const config = { params: { ref: sRef }, responseType: 'text', timeout: 5000 };
    if (enigmaAuth) config.auth = enigmaAuth;
    const response = await axios.get(`${enigmaBase}/web/stream.m3u`, config);
    const m3u = response.data || '';
    for (const line of m3u.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const url = new URL(trimmed);
        // Replace hostname — Docker often can't resolve Fritz.Box mDNS names
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

app.get('/stream/*', requireAuth, async (req, res) => {
  const sRef = decodeURIComponent(req.params[0] || '');
  if (!sRef) return res.status(400).json({ error: 'Missing service reference' });

  const programNum = getProgramNumber(sRef);
  console.log(`Stream request: ${sRef}  program=${programNum}`);

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  const sptsUrl = await resolveSptsUrl(sRef);

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

  // ── Strategy 2: ffmpeg extracts the program from the MPTS on port 8001 ──────
  let sourceUrl = `http://${ENIGMA2_HOST}:${ENIGMA2_STREAM_PORT}/${sRef}`;
  if (ENIGMA2_USER) {
    sourceUrl = `http://${encodeURIComponent(ENIGMA2_USER)}:${encodeURIComponent(ENIGMA2_PASSWORD)}@${ENIGMA2_HOST}:${ENIGMA2_STREAM_PORT}/${sRef}`;
  }

  console.log(`ffmpeg fallback: ${sourceUrl}  program=${programNum}`);

  const ffArgs = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+nobuffer+genpts',
    '-err_detect', 'ignore_err',
    '-probesize', '10000000',
    '-analyzeduration', '10000000',
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
      '-preset', 'veryfast',
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

// ─── Static files & SPA fallback ─────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`E2StreamHub running on http://0.0.0.0:${PORT}`);
  console.log(`Enigma2 receiver: ${enigmaBase}`);
});
