const express = require('express');
const session = require('express-session');
const axios = require('axios');
const http = require('http');
const https = require('https');
const path = require('path');

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
// Proxies the MPEG-TS stream from enigma2 port 8001 to the browser.
// This avoids CORS issues and keeps receiver credentials server-side.

app.get('/stream/*', requireAuth, (req, res) => {
  // Decode the service reference (the client sends it URL-encoded)
  const sRef = decodeURIComponent(req.params[0] || '');
  if (!sRef) return res.status(400).json({ error: 'Missing service reference' });

  console.log(`Stream request: ${sRef}`);

  const reqOptions = {
    hostname: ENIGMA2_HOST,
    port: ENIGMA2_STREAM_PORT,
    path: `/${sRef}`,
    method: 'GET',
    headers: { 'User-Agent': 'E2StreamHub/1.0' },
  };

  if (ENIGMA2_USER) {
    const creds = Buffer.from(`${ENIGMA2_USER}:${ENIGMA2_PASSWORD}`).toString('base64');
    reqOptions.headers['Authorization'] = `Basic ${creds}`;
  }

  let headersSentByUs = false;

  const streamReq = http.request(reqOptions, (streamRes) => {
    const statusCode = streamRes.statusCode || 200;

    // If receiver returns non-200, report it cleanly instead of forwarding HTML error pages
    if (statusCode !== 200) {
      console.error(`Receiver returned HTTP ${statusCode} for stream`);
      streamRes.resume(); // drain to free socket
      if (!res.headersSent) {
        res.status(502).json({ error: `Receiver returned HTTP ${statusCode}` });
      }
      return;
    }

    headersSentByUs = true;
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.status(200);

    streamRes.pipe(res);

    streamRes.on('error', (err) => {
      console.error('Stream response error:', err.message);
      if (!res.writableEnded) res.end();
    });

    streamRes.on('close', () => {
      if (!res.writableEnded) res.end();
    });
  });

  streamReq.on('error', (err) => {
    console.error('Stream request error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Receiver unreachable' });
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  req.on('close', () => {
    streamReq.destroy();
  });

  streamReq.end();
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
