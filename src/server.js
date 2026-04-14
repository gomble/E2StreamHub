const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client: SshClient } = require('ssh2');

const app = express();
const PORT = process.env.PORT || 3000;

const ENIGMA2_HOST = process.env.ENIGMA2_HOST || '192.168.1.100';
const ENIGMA2_PORT = parseInt(process.env.ENIGMA2_PORT || '80', 10);
const ENIGMA2_STREAM_PORT = parseInt(process.env.ENIGMA2_STREAM_PORT || '8001', 10);
const ENIGMA2_USER = process.env.ENIGMA2_USER || '';
const ENIGMA2_PASSWORD = process.env.ENIGMA2_PASSWORD || '';
const ENIGMA2_SSH_PORT = parseInt(process.env.ENIGMA2_SSH_PORT || '22', 10);
const APP_USERNAME = process.env.APP_USERNAME || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'e2streamhub-change-this-secret';
const FFMPEG_FORCE_VIDEO_TRANSCODE = String(process.env.FFMPEG_FORCE_VIDEO_TRANSCODE || '').toLowerCase() === 'true';
const FFMPEG_PROBESIZE = process.env.FFMPEG_PROBESIZE || '10000000';
const FFMPEG_ANALYZEDURATION = process.env.FFMPEG_ANALYZEDURATION || '10000000';
const FFMPEG_TRANSCODE_PRESET = process.env.FFMPEG_TRANSCODE_PRESET || 'veryfast';
const HLS_SEGMENT_SECONDS = parseInt(process.env.HLS_SEGMENT_SECONDS || '2', 10);
const HLS_LIST_SIZE = parseInt(process.env.HLS_LIST_SIZE || '4', 10);

const enigmaBase = `http://${ENIGMA2_HOST}:${ENIGMA2_PORT}`;
const enigmaAuth = ENIGMA2_USER
  ? { username: ENIGMA2_USER, password: ENIGMA2_PASSWORD }
  : null;

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

function buildSourceUrl(sRef) {
  // Port 8001 is the Enigma2 streaming port — it does not use HTTP auth.
  // Credentials only apply to the OpenWebif API on ENIGMA2_PORT (usually 80).
  return `http://${ENIGMA2_HOST}:${ENIGMA2_STREAM_PORT}/${sRef}`;
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

async function enigmaReadFile(filePath) {
  const config = {
    params: { file: filePath },
    timeout: 15000,
    responseType: 'text',
    transformResponse: [d => d],
  };
  if (enigmaAuth) config.auth = enigmaAuth;
  const { data } = await axios.get(`${enigmaBase}/api/file`, config);
  return data;
}

async function enigmaWriteFile(filePath, content) {
  // Try OpenWebif HTTP file API first
  try {
    const body = new URLSearchParams({ filename: filePath, file: content }).toString();
    const config = {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    };
    if (enigmaAuth) config.auth = enigmaAuth;
    await axios.post(`${enigmaBase}/api/file`, body, config);
    return; // success
  } catch (err) {
    if (err.response?.status !== 404 && err.response?.status !== 405) throw err;
    // HTTP file API not available — fall through to SSH
    console.warn('[enigmaWriteFile] HTTP file API unavailable, trying SSH');
  }

  // SSH fallback: write file directly via SFTP
  if (!ENIGMA2_USER || !ENIGMA2_PASSWORD) {
    throw new Error('SSH-Schreiben fehlgeschlagen: ENIGMA2_USER / ENIGMA2_PASSWORD nicht konfiguriert');
  }
  await sshWriteFile(ENIGMA2_HOST, ENIGMA2_SSH_PORT, ENIGMA2_USER, ENIGMA2_PASSWORD, filePath, content);
}

function sshWriteFile(host, port, user, password, remotePath, content) {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    const buf = Buffer.from(content, 'utf8');

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }

        const stream = sftp.createWriteStream(remotePath, { flags: 'w' });
        stream.on('error', e => { conn.end(); reject(e); });
        stream.on('close', () => { conn.end(); resolve(); });
        stream.end(buf);
      });
    });

    conn.on('error', reject);

    conn.connect({
      host,
      port,
      username: user,
      password,
      readyTimeout: 10000,
      // Accept any host key (receiver is on local network, no CA)
      hostVerifier: () => true,
    });
  });
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
    const isMarker = svcTypePart === '832' || parseInt(svcTypePart, 16) === 0x832;
    const isSubBouquet = sRef.toUpperCase().includes('FROM BOUQUET');
    const id = `i${++seq}_${Date.now()}`;

    if (isMarker) {
      items.push({ type: 'marker', sRef, label: description, id });
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
  for (const item of items) {
    // New markers created in the editor may not have a sRef — generate the standard one
    const sRef = item.sRef || (item.type === 'marker' ? '1:832:1:0:0:0:0:0:0:0:' : null);
    if (!sRef) continue; // skip items without a valid sRef
    out += `#SERVICE ${sRef}\n`;
    const label = item.type === 'service' ? (item.name || '') : (item.label || '');
    out += `#DESCRIPTION ${label}\n`;
  }
  return out;
}

app.get('/api/bouquetedit', requireAuth, async (req, res) => {
  const bRef = req.query.bRef || '';
  const filePath = bouquetFilePath(bRef);
  if (!filePath) return res.status(400).json({ error: 'Invalid bouquet reference' });

  // Try to read the actual bouquet file (preserves markers / order)
  try {
    const content = await enigmaReadFile(filePath);
    const parsed = parseBouquetFile(content);
    return res.json({ ...parsed, filePath });
  } catch (err) {
    const status = err.response?.status;
    if (status !== 404 && status !== 405) {
      // Unexpected error — report it
      console.error('[bouquetedit] read error:', err.message);
      return res.status(502).json({ error: err.message });
    }
    // File API not available on this OpenWebif version — fall back to services list
    console.warn('[bouquetedit] /api/file not available (HTTP %d), falling back to getservices', status);
  }

  // Fallback: reconstruct bouquet from the working /api/getservices endpoint.
  // Markers are not preserved in this path, but channel list and order are.
  try {
    const svcData = await enigmaGet('/api/getservices', { sRef: bRef });
    const services = svcData.services || [];
    // Derive a display name from the file path (e.g. "userbouquet.ciefpskyde.tv" → "ciefpskyde")
    const name = filePath.split('/').pop()
      .replace(/^userbouquet\./, '')
      .replace(/\.[^.]+$/, '');
    const items = services.map((svc, i) => ({
      type: 'service',
      sRef: svc.servicereference,
      name: svc.servicename,
      id: `i${i + 1}`,
    }));
    return res.json({ name, items, filePath });
  } catch (err2) {
    console.error('[bouquetedit] fallback getservices error:', err2.message);
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
    const content = serializeBouquetFile(name, items);
    await enigmaWriteFile(filePath, content);
    enigmaGet('/api/reloadservices').catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('[bouquetedit] write error:', err.message, 'status:', err.response?.status);
    if (err.response?.status === 404 || err.response?.status === 405) {
      return res.status(502).json({
        error: 'Speichern nicht möglich: Diese OpenWebif-Version unterstützt keine Datei-API. Bitte OpenWebif aktualisieren.',
      });
    }
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

app.post('/hls/start', requireAuth, async (req, res) => {
  try {
    const sRef = String(req.body?.sRef || '');
    if (!sRef) return res.status(400).json({ error: 'Missing service reference' });

    const decodedSRef = decodeURIComponent(sRef);
    const programNum = getProgramNumber(decodedSRef);
    const sessionId = crypto.randomUUID();
    // Re-create root in case the OS flushed /tmp between container restarts
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
  // Port 8001 (streaming) does not use HTTP auth — credentials not needed.
  const sourceUrl = `http://${ENIGMA2_HOST}:${ENIGMA2_STREAM_PORT}/${sRef}`;

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

app.get('/stream-fmp4/*', requireAuth, async (req, res) => {
  const sRef = decodeURIComponent(req.params[0] || '');
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
  let killed = false;
  for (const [key, ff] of [...activeFmp4Streams.entries()]) {
    ff.kill('SIGTERM');
    activeFmp4Streams.delete(key);
    await new Promise(r => ff.once('close', r));
    killed = true;
  }
  // Give the receiver time to close its HTTP connection before we reconnect.
  if (killed) await new Promise(r => setTimeout(r, 700));

  const programNum = getProgramNumber(sRef);
  console.log(`fMP4 stream: ${sRef}  program=${programNum}`);

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  let sourceUrl;
  try {
    // Prefer the single-program URL from OpenWebif if on a dedicated port
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
  } catch (err) {
    resolveMySettle();
    return res.status(502).json({ error: 'Failed to resolve stream URL' });
  }

  const ffArgs = [
    '-hide_banner',
    '-loglevel', 'warning',
    // Low probesize/analyzeduration for fast startup on live MPEG-TS streams.
    // The source format is well-known; deep analysis only adds latency.
    '-fflags', '+nobuffer+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-max_error_rate', '1.0',
    '-probesize', '1000000',
    '-analyzeduration', '1000000',
    '-i', sourceUrl,
    '-ignore_unknown',
  ];

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
      const delay = attempt * 800; // 800, 1600, 2400, 3200 ms
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
