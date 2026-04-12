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
// Port 8001 on Enigma2 delivers the full transponder (MPTS – multiple programmes).
// ffmpeg selects the desired programme by number and re-muxes it to a clean SPTS
// before forwarding it to the browser. This is exactly what VLC does internally
// via the #EXTVLCOPT:program= directive in M3U files.

app.get('/stream/*', requireAuth, (req, res) => {
  const sRef = decodeURIComponent(req.params[0] || '');
  if (!sRef) return res.status(400).json({ error: 'Missing service reference' });

  const programNum = getProgramNumber(sRef);
  let sourceUrl = `http://${ENIGMA2_HOST}:${ENIGMA2_STREAM_PORT}/${sRef}`;

  // Embed HTTP basic auth credentials into the URL for ffmpeg if needed
  if (ENIGMA2_USER) {
    sourceUrl = `http://${encodeURIComponent(ENIGMA2_USER)}:${encodeURIComponent(ENIGMA2_PASSWORD)}@${ENIGMA2_HOST}:${ENIGMA2_STREAM_PORT}/${sRef}`;
  }

  console.log(`Stream: ${sRef}  program=${programNum}  src=${ENIGMA2_HOST}:${ENIGMA2_STREAM_PORT}`);

  const ffArgs = [
    '-hide_banner',
    '-loglevel', 'warning',
    // Give ffmpeg enough data to find a full IDR frame before starting output
    '-fflags', '+nobuffer+discardcorrupt+genpts',
    '-probesize', '5000000',        // 5 MB
    '-analyzeduration', '5000000',  // 5 seconds
    '-i', sourceUrl,
  ];

  // Select specific program (service ID) from the MPTS
  if (programNum) {
    ffArgs.push('-map', `0:p:${programNum}`);
  } else {
    ffArgs.push('-map', '0');
  }

  ffArgs.push(
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-c:s', 'copy',
    '-copyts',
    '-f', 'mpegts',
    // Resend PAT/PMT frequently so the browser player syncs fast
    '-mpegts_flags', 'resend_headers+pat_pmt_at_frames',
    '-avoid_negative_ts', 'make_zero',
    'pipe:1',
  );

  const ff = spawn('ffmpeg', ffArgs);

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  ff.stdout.pipe(res);

  ff.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`ffmpeg [${sRef.substring(0, 20)}]: ${msg}`);
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

  req.on('close', () => {
    ff.kill('SIGTERM');
  });
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
