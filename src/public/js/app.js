/* ─── E2StreamHub – Main App ─────────────────────────────────────────────── */

(async () => {
  // Auth check on load
  const authRes = await fetch('/auth/check').then(r => r.json()).catch(() => ({ authenticated: false }));
  if (!authRes.authenticated) {
    window.location.href = '/login.html';
    return;
  }

  // ─── State ────────────────────────────────────────────────────────────────
  let player = null;
  let currentSRef = null;
  let currentChannelName = null;
  let epgRefreshTimer = null;
  let channelEpgMap = {}; // sRef → current EPG event for channel list display

  // ─── Elements ─────────────────────────────────────────────────────────────
  const bouquetSelect = document.getElementById('bouquetSelect');
  const channelList   = document.getElementById('channelList');
  const videoEl       = document.getElementById('videoPlayer');
  const videoOverlay  = document.getElementById('videoOverlay');
  const bufferingSpinner = document.getElementById('bufferingSpinner');
  const epgContent    = document.getElementById('epgContent');
  const nowPlaying    = document.getElementById('nowPlaying');
  const npChannel     = document.getElementById('npChannel');
  const npTitle       = document.getElementById('npTitle');
  const npTime        = document.getElementById('npTime');
  const npProgress    = document.getElementById('npProgress');
  const statusDot     = document.getElementById('statusDot');
  const currentTime   = document.getElementById('currentTime');

  // ─── Clock ────────────────────────────────────────────────────────────────
  function updateClock() {
    const now = new Date();
    currentTime.textContent = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  updateClock();
  setInterval(updateClock, 1000);

  // ─── Receiver status check ────────────────────────────────────────────────
  async function checkStatus() {
    try {
      await fetch('/api/statusinfo');
      statusDot.classList.remove('offline');
      statusDot.classList.add('online');
    } catch {
      statusDot.classList.remove('online');
      statusDot.classList.add('offline');
    }
  }
  checkStatus();
  setInterval(checkStatus, 30000);

  // ─── Navigation ───────────────────────────────────────────────────────────
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('view' + capitalize(btn.dataset.view)).classList.add('active');

      if (btn.dataset.view === 'epg') {
        syncEpgBouquetSelect();
      }
    });
  });

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // ─── Logout ───────────────────────────────────────────────────────────────
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  // ─── Bouquets ─────────────────────────────────────────────────────────────
  async function loadBouquets() {
    try {
      const data = await apiFetch('/api/bouquets');
      const bouquets = data.bouquets || [];
      bouquetSelect.innerHTML = '<option value="">Select bouquet…</option>';
      bouquets.forEach(([ref, name]) => {
        const opt = document.createElement('option');
        opt.value = ref;
        opt.textContent = name;
        bouquetSelect.appendChild(opt);
      });
    } catch (e) {
      bouquetSelect.innerHTML = '<option value="">Failed to load</option>';
      console.error('Bouquet load error:', e);
    }
  }

  bouquetSelect.addEventListener('change', () => {
    if (bouquetSelect.value) loadChannels(bouquetSelect.value);
  });

  // ─── Channels ─────────────────────────────────────────────────────────────
  async function loadChannels(bouquetRef) {
    channelList.innerHTML = '<div class="list-placeholder">Loading channels…</div>';
    try {
      const data = await apiFetch(`/api/services?sRef=${encodeURIComponent(bouquetRef)}`);
      const services = data.services || [];

      if (services.length === 0) {
        channelList.innerHTML = '<div class="list-placeholder">No channels found</div>';
        return;
      }

      channelList.innerHTML = '';
      services.forEach((svc, idx) => {
        const item = document.createElement('div');
        item.className = 'channel-item';
        item.dataset.sref = svc.servicereference;
        item.dataset.name = svc.servicename;
        item.innerHTML = `
          <span class="channel-num">${idx + 1}</span>
          <span class="channel-name">${escHtml(svc.servicename)}</span>
          <span class="channel-now" id="cnow-${sanitizeId(svc.servicereference)}"></span>
        `;
        item.addEventListener('click', () => tuneChannel(svc.servicereference, svc.servicename, item));
        channelList.appendChild(item);
      });

      // Load short EPG for channel list (debounced / lightweight)
      loadChannelListEpg(services.slice(0, 40));
    } catch (e) {
      channelList.innerHTML = `<div class="list-placeholder">Error: ${escHtml(e.message)}</div>`;
    }
  }

  async function loadChannelListEpg(services) {
    // Load EPG for visible channels in background to show "now playing" in list
    for (const svc of services) {
      try {
        const data = await apiFetch(`/api/epg?sRef=${encodeURIComponent(svc.servicereference)}`);
        const events = data.events || [];
        const now = Date.now() / 1000;
        const current = events.find(e => e.begin_timestamp <= now && (e.begin_timestamp + e.duration_sec) > now);
        if (current) {
          const el = document.getElementById(`cnow-${sanitizeId(svc.servicereference)}`);
          if (el) el.textContent = current.title || '';
        }
      } catch { /* skip */ }
      await sleep(50);
    }
  }

  // ─── Channel tuning & streaming ───────────────────────────────────────────
  function tuneChannel(sRef, name, itemEl) {
    // Mark active
    document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
    if (itemEl) itemEl.classList.add('active');

    currentSRef = sRef;
    currentChannelName = name;

    videoOverlay.classList.add('hidden');
    bufferingSpinner.classList.add('visible');

    // Destroy previous player instance
    if (player) {
      try { player.destroy(); } catch { }
      player = null;
    }
    videoEl.src = '';

    const streamUrl = `/stream/${encodeURIComponent(sRef)}`;

    if (mpegts.isSupported()) {
      player = mpegts.createPlayer({
        type: 'mpegts',
        url: streamUrl,
        isLive: true,
      }, {
        enableWorker: true,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 3.0,
        liveBufferLatencyMinRemain: 0.5,
      });

      player.attachMediaElement(videoEl);
      player.load();
      player.play().catch(() => {});

      player.on(mpegts.Events.ERROR, (errType, errDetail) => {
        console.error('mpegts error:', errType, errDetail);
        bufferingSpinner.classList.remove('visible');
      });
    } else {
      // Fallback: set src directly (may work for some browsers / formats)
      videoEl.src = streamUrl;
      videoEl.play().catch(() => {});
    }

    videoEl.onwaiting = () => bufferingSpinner.classList.add('visible');
    videoEl.onplaying = () => bufferingSpinner.classList.remove('visible');
    videoEl.oncanplay = () => bufferingSpinner.classList.remove('visible');

    // Load EPG for the selected channel
    loadEpgPanel(sRef, name);
    startEpgRefresh(sRef, name);
  }

  // ─── EPG Side Panel ───────────────────────────────────────────────────────
  async function loadEpgPanel(sRef, channelName) {
    epgContent.innerHTML = '<div class="epg-empty">Loading EPG…</div>';
    nowPlaying.style.display = 'none';

    try {
      const data = await apiFetch(`/api/epg?sRef=${encodeURIComponent(sRef)}`);
      const events = (data.events || []).slice(0, 20);

      if (events.length === 0) {
        epgContent.innerHTML = '<div class="epg-empty">No EPG data available</div>';
        return;
      }

      const now = Date.now() / 1000;
      epgContent.innerHTML = '';

      events.forEach(evt => {
        const start = evt.begin_timestamp;
        const end = start + evt.duration_sec;
        const isCurrent = start <= now && end > now;
        const startDate = new Date(start * 1000);
        const endDate = new Date(end * 1000);
        const timeStr = `${fmtTime(startDate)} – ${fmtTime(endDate)}`;
        const durMin = Math.round(evt.duration_sec / 60);

        const div = document.createElement('div');
        div.className = `epg-event${isCurrent ? ' current' : ''}`;
        div.innerHTML = `
          <div class="epg-event-time">${timeStr}</div>
          <div class="epg-event-title">${escHtml(evt.title || '–')}</div>
          ${evt.shortdesc ? `<div class="epg-event-desc">${escHtml(evt.shortdesc)}</div>` : ''}
          <div class="epg-event-duration">${durMin} min</div>
        `;
        epgContent.appendChild(div);

        if (isCurrent) {
          updateNowPlayingBar(channelName, evt, now);
          // Scroll current event into view
          setTimeout(() => div.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 100);
        }
      });
    } catch (e) {
      epgContent.innerHTML = `<div class="epg-empty">Error: ${escHtml(e.message)}</div>`;
    }
  }

  function updateNowPlayingBar(channelName, evt, now) {
    nowPlaying.style.display = 'flex';
    npChannel.textContent = channelName;
    npTitle.textContent = evt.title || '';
    const start = evt.begin_timestamp;
    const end = start + evt.duration_sec;
    const startDate = new Date(start * 1000);
    const endDate = new Date(end * 1000);
    npTime.textContent = `${fmtTime(startDate)} – ${fmtTime(endDate)}  (${Math.round(evt.duration_sec / 60)} min)`;
    const pct = ((now - start) / evt.duration_sec) * 100;
    npProgress.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }

  function startEpgRefresh(sRef, name) {
    clearInterval(epgRefreshTimer);
    epgRefreshTimer = setInterval(() => loadEpgPanel(sRef, name), 60000);
  }

  // ─── EPG bouquet select sync ───────────────────────────────────────────────
  function syncEpgBouquetSelect() {
    const epgBouquetSelect = document.getElementById('epgBouquetSelect');
    epgBouquetSelect.innerHTML = bouquetSelect.innerHTML;
    epgBouquetSelect.value = bouquetSelect.value;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  async function apiFetch(url) {
    const res = await fetch(url);
    if (res.status === 401) {
      window.location.href = '/login.html';
      throw new Error('Unauthorized');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTime(date) {
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function sanitizeId(str) {
    return str.replace(/[^a-zA-Z0-9]/g, '_');
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  loadBouquets();

  // Expose helpers for epg-timeline.js
  window._app = {
    apiFetch,
    escHtml,
    fmtTime,
    tuneChannel,
    bouquetSelect,
  };
})();
