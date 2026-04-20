/* ─── E2StreamHub – Main App ─────────────────────────────────────────────── */

(async () => {
  // Auth check on load
  const authRes = await fetch('/auth/check').then(r => r.json()).catch(() => ({ authenticated: false }));
  if (!authRes.authenticated) {
    window.location.href = '/login.html';
    return;
  }

  // ─── State ────────────────────────────────────────────────────────────────
  let player = null;        // mpegts.js player (last-resort fallback)
  let hlsPlayer = null;     // hls.js player (old-iOS fallback)
  let hlsSessionId = null;
  let fmp4Abort = null;     // AbortController for the primary fMP4 stream
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

  // ─── Program Detail Modal ─────────────────────────────────────────────────
  const eventModal    = document.getElementById('eventModal');
  const evtModalClose = document.getElementById('eventModalClose');

  function openEventModal(evt, channelName, sRef) {
    _evtModalSRef = sRef || null;
    _evtModalName = channelName || null;
    const now = Date.now() / 1000;
    const start = evt.begin_timestamp;
    const end   = start + evt.duration_sec;
    const startDate = new Date(start * 1000);
    const endDate   = new Date(end   * 1000);
    const durMin = Math.round(evt.duration_sec / 60);
    const isCurrent = start <= now && end > now;

    document.getElementById('evtModalChannel').textContent = channelName || '';
    document.getElementById('evtModalTitle').textContent = decodeHtml(evt.title || '');
    document.getElementById('evtModalMeta').textContent =
      `${fmtDateTime(startDate)} – ${fmtTime(endDate)}  ·  ${durMin} min`;

    const progressWrap = document.getElementById('evtModalProgressWrap');
    if (isCurrent) {
      const pct = ((now - start) / evt.duration_sec) * 100;
      document.getElementById('evtModalProgress').style.width = `${Math.min(100, pct)}%`;
      progressWrap.style.display = 'block';
    } else {
      progressWrap.style.display = 'none';
    }

    document.getElementById('evtModalShort').textContent = decodeHtml(evt.shortdesc || '');
    document.getElementById('evtModalLong').textContent = decodeHtml(evt.longdesc || '');

    eventModal.classList.add('open');
    eventModal.setAttribute('aria-hidden', 'false');

    // Fetch longdesc if we have an event id and it's not already loaded
    const eventid = evt.id || evt.eventid;
    if (sRef && eventid && !evt.longdesc) {
      apiFetch(`/api/epgevent?eventid=${encodeURIComponent(eventid)}&sRef=${encodeURIComponent(sRef)}`)
        .then(data => {
          const ev = (data.events || [])[0];
          if (ev && ev.longdesc) {
            document.getElementById('evtModalLong').textContent = decodeHtml(ev.longdesc);
          }
          if (ev && ev.shortdesc && !evt.shortdesc) {
            document.getElementById('evtModalShort').textContent = decodeHtml(ev.shortdesc);
          }
        }).catch(() => {});
    }
  }

  function closeEventModal() {
    eventModal.classList.remove('open');
    eventModal.setAttribute('aria-hidden', 'true');
  }

  let _evtModalSRef = null;
  let _evtModalName = null;

  document.getElementById('evtModalTuneBtn').addEventListener('click', () => {
    if (!_evtModalSRef) return;
    closeEventModal();
    // Close EPG overlay if open
    if (epgOverlay && epgOverlay.classList.contains('open')) {
      epgOverlay.classList.remove('open');
      epgOverlay.setAttribute('aria-hidden', 'true');
    }
    const sideItem = [...document.querySelectorAll('.channel-item')].find(el => el.dataset.sref === _evtModalSRef) || null;
    tuneChannel(_evtModalSRef, _evtModalName, sideItem);
  });

  evtModalClose.addEventListener('click', closeEventModal);
  eventModal.addEventListener('click', e => { if (e.target === eventModal) closeEventModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && eventModal.classList.contains('open')) closeEventModal();
  });

  function fmtDateTime(date) {
    return date.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // ─── Navigation ───────────────────────────────────────────────────────────
  const epgOverlay = document.getElementById('epgOverlay');
  const editorOverlay = document.getElementById('editorOverlay');
  const receiverOverlay = document.getElementById('receiverOverlay');

  // ─── Picture-in-Picture ────────────────────────────────────────────────────
  const pipWindow       = document.getElementById('pipWindow');
  const pipChannelBadge = document.getElementById('pipChannel');
  const pipClose        = document.getElementById('pipClose');
  const videoWrapper    = document.querySelector('.video-wrapper');

  function showPip() {
    if (!currentSRef) return;
    pipChannelBadge.textContent = currentChannelName || '';
    videoEl.controls = false;
    pipWindow.appendChild(videoEl);
    pipWindow.classList.add('active');
  }

  function hidePip() {
    if (!pipWindow.classList.contains('active')) return;
    videoWrapper.insertBefore(videoEl, videoWrapper.querySelector('.video-overlay'));
    videoEl.controls = true;
    pipWindow.classList.remove('active');
  }

  function updatePip() {
    const anyOpen = epgOverlay.classList.contains('open')
                 || editorOverlay.classList.contains('open')
                 || receiverOverlay.classList.contains('open');
    if (anyOpen && currentSRef) showPip();
    else hidePip();
  }

  pipClose.addEventListener('click', () => {
    hidePip();
    pipWindow.classList.remove('active');
  });

  // Drag PiP window
  (function initPipDrag() {
    let dragging = false, ox = 0, oy = 0;
    pipWindow.addEventListener('mousedown', e => {
      if (e.target.closest('.pip-close') || e.target.closest('.pip-resize')) return;
      dragging = true;
      ox = e.clientX - pipWindow.offsetLeft;
      oy = e.clientY - pipWindow.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      pipWindow.style.left = `${e.clientX - ox}px`;
      pipWindow.style.top  = `${e.clientY - oy}px`;
      pipWindow.style.right = 'auto';
      pipWindow.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    // Resize from bottom-left corner
    const resizeHandle = pipWindow.querySelector('.pip-resize');
    let resizing = false, startW = 0, startX = 0;
    resizeHandle.addEventListener('mousedown', e => {
      resizing = true;
      startW = pipWindow.offsetWidth;
      startX = e.clientX;
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', e => {
      if (!resizing) return;
      const newW = Math.max(200, Math.min(640, startW - (e.clientX - startX)));
      pipWindow.style.width = `${newW}px`;
    });
    document.addEventListener('mouseup', () => { resizing = false; });
  })();

  function openEpgOverlay() {
    syncEpgBouquetSelect();
    epgOverlay.classList.add('open');
    epgOverlay.setAttribute('aria-hidden', 'false');
    updatePip();
  }

  function closeEpgOverlay() {
    epgOverlay.classList.remove('open');
    epgOverlay.setAttribute('aria-hidden', 'true');
    updatePip();
  }

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view === 'epg') {
        openEpgOverlay();
      } else if (btn.dataset.view === 'editor') {
        if (window._editorOpen) window._editorOpen();
      } else if (btn.dataset.view === 'receiver') {
        if (window._receiverOpen) window._receiverOpen();
      }
    });
  });

  // Close on backdrop click (click on overlay but not the panel)
  epgOverlay.addEventListener('click', e => {
    if (e.target === epgOverlay) closeEpgOverlay();
  });

  document.getElementById('epgCloseBtn').addEventListener('click', closeEpgOverlay);

  // Close on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && epgOverlay.classList.contains('open')) closeEpgOverlay();
  });

  // ─── Logout ───────────────────────────────────────────────────────────────
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  // ─── Bouquets ─────────────────────────────────────────────────────────────
  let allBouquets = [];            // [{ ref, name }]
  const channelCache = new Map();  // bouquetRef → services[]

  async function loadBouquets() {
    try {
      const data = await apiFetch('/api/bouquets');
      const bouquets = data.bouquets || [];
      allBouquets = bouquets.map(([ref, name]) => ({ ref, name }));
      bouquetSelect.innerHTML = '<option value="">Select bouquet…</option>';
      allBouquets.forEach(({ ref, name }) => {
        const opt = document.createElement('option');
        opt.value = ref;
        opt.textContent = name;
        bouquetSelect.appendChild(opt);
      });

      // Restore last used bouquet, or auto-select the first one
      const lastBouquet = localStorage.getItem('lastBouquet');
      let activeBouquet = null;
      if (lastBouquet && allBouquets.some(b => b.ref === lastBouquet)) {
        activeBouquet = lastBouquet;
      } else if (allBouquets.length > 0) {
        activeBouquet = allBouquets[0].ref;
      }
      if (activeBouquet) {
        bouquetSelect.value = activeBouquet;
        localStorage.setItem('lastBouquet', activeBouquet);
        await loadChannels(activeBouquet);
        scheduleEpgPreload(activeBouquet);
      }
    } catch (e) {
      bouquetSelect.innerHTML = '<option value="">Failed to load</option>';
      console.error('Bouquet load error:', e);
    }
  }

  // ─── Background EPG preload ────────────────────────────────────────────────
  // Preloads EPG data for the current bouquet so EPG Guide is ready instantly.
  let epgPreloadTimer = null;

  function scheduleEpgPreload(bouquetRef) {
    clearTimeout(epgPreloadTimer);
    // Start EPG preload after a short delay to let the UI settle
    epgPreloadTimer = setTimeout(() => preloadEpgForBouquet(bouquetRef), 2000);
  }

  async function preloadEpgForBouquet(bouquetRef) {
    try {
      const svcData  = await apiFetch(`/api/services?sRef=${encodeURIComponent(bouquetRef)}`);
      const services = (svcData.services || []).slice(0, 50);
      if (!services.length) return;

      // Use the same batched approach as epg-timeline.js
      const BATCH = 6;
      for (let i = 0; i < services.length; i += BATCH) {
        const batch = services.slice(i, i + BATCH);
        await Promise.all(batch.map(async svc => {
          try {
            const data = await apiFetch(`/api/epg?sRef=${encodeURIComponent(svc.servicereference)}`);
            // epg-timeline.js reads from window._epgCache — store there for it to pick up
            if (!window._epgCache) window._epgCache = {};
            window._epgCache[svc.servicereference] = data.events || [];
          } catch { /* skip */ }
        }));
        // Small pause between batches to avoid hammering the receiver
        await sleep(200);
      }

      // Pre-select the bouquet in the EPG overlay select
      syncEpgBouquetSelect();
      const epgBq = document.getElementById('epgBouquetSelect');
      if (epgBq && bouquetRef) epgBq.value = bouquetRef;

      console.log('[epg-preload] done for', bouquetRef);
    } catch (e) {
      console.warn('[epg-preload] failed:', e.message);
    }
  }

  bouquetSelect.addEventListener('change', () => {
    document.getElementById('channelSearch').value = '';
    if (bouquetSelect.value) {
      localStorage.setItem('lastBouquet', bouquetSelect.value);
      loadChannels(bouquetSelect.value);
    }
  });

  // ─── Channels ─────────────────────────────────────────────────────────────
  function piconUrl(sRef) {
    return `/picon/${encodeURIComponent(sRef)}`;
  }

  function piconImg(sRef) {
    if (!sRef) return '';
    const url = piconUrl(sRef);
    return `<img class="picon" src="${url}" alt="" loading="lazy" onerror="this.style.display='none'">`;
  }

  function renderChannelList(services, bouquetRef) {
    channelList.innerHTML = '';
    services.forEach((svc, idx) => {
      const item = document.createElement('div');
      item.className = 'channel-item';
      item.dataset.sref = svc.servicereference;
      item.dataset.name = svc.servicename;
      item.dataset.bouquet = bouquetRef;
      item.innerHTML = `
        <span class="channel-num">${idx + 1}</span>
        ${piconImg(svc.servicereference)}
        <span class="channel-name">${escHtml(svc.servicename)}</span>
        <span class="channel-now" id="cnow-${sanitizeId(svc.servicereference)}"></span>
      `;
      item.addEventListener('click', () => {
        clearTimeout(item._tuneTimer);
        item._tuneTimer = setTimeout(() => tuneChannel(svc.servicereference, svc.servicename, item), 250);
      });
      channelList.appendChild(item);
    });
  }

  async function loadChannels(bouquetRef) {
    channelList.innerHTML = '<div class="list-placeholder">Loading…</div>';
    try {
      let services = channelCache.get(bouquetRef);
      if (!services) {
        const data = await apiFetch(`/api/services?sRef=${encodeURIComponent(bouquetRef)}`);
        services = data.services || [];
        channelCache.set(bouquetRef, services);
      }
      if (services.length === 0) {
        channelList.innerHTML = '<div class="list-placeholder">No channels found</div>';
        return;
      }
      renderChannelList(services, bouquetRef);
      loadChannelListEpg(services.slice(0, 40));
    } catch (e) {
      channelList.innerHTML = `<div class="list-placeholder">Error: ${escHtml(e.message)}</div>`;
    }
  }

  // ─── Cross-bouquet search ──────────────────────────────────────────────────
  let searchDebounce = null;
  let searchAbort = null;

  document.getElementById('channelSearch').addEventListener('input', e => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(e.target.value), 250);
  });

  async function runSearch(term) {
    const q = term.trim().toLowerCase();

    // Empty search → restore current bouquet view
    if (!q) {
      const ref = bouquetSelect.value;
      if (ref) {
        loadChannels(ref);
      } else {
        channelList.innerHTML = '<div class="list-placeholder">Please select a bouquet</div>';
      }
      return;
    }

    // Abort any previous in-flight search
    if (searchAbort) { searchAbort.aborted = true; }
    const abort = { aborted: false };
    searchAbort = abort;

    channelList.innerHTML = '<div class="list-placeholder">Searching…</div>';

    // Collect results: first search already-cached bouquets instantly,
    // then fetch the rest in background and append as they arrive.
    const results = []; // { svc, bouquetRef, bouquetName }

    for (const { ref, name: bouquetName } of allBouquets) {
      if (abort.aborted) return;

      let services = channelCache.get(ref);
      if (!services) {
        try {
          const data = await apiFetch(`/api/services?sRef=${encodeURIComponent(ref)}`);
          services = data.services || [];
          channelCache.set(ref, services);
        } catch { continue; }
      }
      if (abort.aborted) return;

      const matches = services.filter(s => s.servicename.toLowerCase().includes(q));
      matches.forEach(svc => results.push({ svc, bouquetRef: ref, bouquetName }));

      // Re-render after each bouquet so results appear progressively
      renderSearchResults(results, q, term);
    }
  }

  function renderSearchResults(results, q, term) {
    channelList.innerHTML = '';

    if (results.length === 0) {
      channelList.innerHTML = `<div class="list-placeholder">No results for "${escHtml(term)}"</div>`;
      return;
    }

    // Group by bouquet for rendering, but keep match order flat
    let lastBouquet = null;
    results.forEach(({ svc, bouquetRef, bouquetName }) => {
      if (bouquetName !== lastBouquet) {
        lastBouquet = bouquetName;
        const sep = document.createElement('div');
        sep.className = 'search-bouquet-label';
        sep.textContent = bouquetName;
        channelList.appendChild(sep);
      }

      const item = document.createElement('div');
      item.className = 'channel-item';
      item.dataset.sref = svc.servicereference;
      item.dataset.name = svc.servicename;

      // Highlight matching part of name
      const nameLower = svc.servicename.toLowerCase();
      const idx = nameLower.indexOf(q);
      let highlighted;
      if (idx >= 0) {
        highlighted = escHtml(svc.servicename.slice(0, idx))
          + `<mark>${escHtml(svc.servicename.slice(idx, idx + q.length))}</mark>`
          + escHtml(svc.servicename.slice(idx + q.length));
      } else {
        highlighted = escHtml(svc.servicename);
      }

      item.innerHTML = `
        ${piconImg(svc.servicereference)}
        <span class="channel-name" style="padding-left:0">${highlighted}</span>
        <span class="channel-now" id="cnow-${sanitizeId(svc.servicereference)}"></span>
      `;

      item.addEventListener('click', () => {
        clearTimeout(item._tuneTimer);
        item._tuneTimer = setTimeout(async () => {
          // Switch bouquet in the select + cache, then tune
          bouquetSelect.value = bouquetRef;
          document.getElementById('channelSearch').value = '';
          await loadChannels(bouquetRef);
          // Find the rendered item for this sRef and mark active
          const rendered = channelList.querySelector(`[data-sref="${CSS.escape(svc.servicereference)}"]`);
          tuneChannel(svc.servicereference, svc.servicename, rendered);
        }, 250);
      });

      channelList.appendChild(item);
    });
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
          if (el) el.textContent = decodeHtml(current.title || '');
        }
      } catch { /* skip */ }
      await sleep(50);
    }
  }

  // ─── Primary: Fragmented MP4 via MSE ─────────────────────────────────────
  // Works on all modern browsers including iOS Safari 13+.
  // No files on disk, no session management — just a piped HTTP stream.
  const FMP4_MIME = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';

  function fmp4Supported() {
    return !!(window.MediaSource && MediaSource.isTypeSupported(FMP4_MIME));
  }

  async function startFmp4Playback(sRef, onFatalFallback) {
    if (!fmp4Supported()) throw new Error('MSE/fMP4 not supported');

    fmp4Abort = new AbortController();

    const ms = new MediaSource();
    videoEl.src = URL.createObjectURL(ms);

    await new Promise((resolve, reject) => {
      ms.addEventListener('sourceopen', resolve, { once: true });
      ms.addEventListener('error', () => reject(new Error('MediaSource error')), { once: true });
    });

    let sb;
    try {
      sb = ms.addSourceBuffer(FMP4_MIME);
    } catch (e) {
      throw new Error(`SourceBuffer init failed: ${e.message}`);
    }

    const waitSb = () => sb.updating
      ? new Promise(r => sb.addEventListener('updateend', r, { once: true }))
      : Promise.resolve();

    // Feed the fMP4 byte stream into the SourceBuffer in background
    (async () => {
      try {
        const resp = await fetch(`/stream-fmp4/${encodeURIComponent(sRef)}`, {
          signal: fmp4Abort.signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const reader = resp.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          await waitSb();

          // Keep buffer to ~20 s to avoid QuotaExceededError
          if (sb.buffered.length > 0 && videoEl.currentTime > 25) {
            const trimTo = Math.max(sb.buffered.start(0), videoEl.currentTime - 15);
            if (trimTo > sb.buffered.start(0) + 1) {
              sb.remove(sb.buffered.start(0), trimTo);
              await waitSb();
            }
          }

          try {
            sb.appendBuffer(value instanceof Uint8Array ? value.buffer : value);
          } catch (appendErr) {
            console.warn('fMP4 appendBuffer:', appendErr.message);
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') return; // normal stop via stopCurrentPlayback
        console.error('fMP4 stream error:', err.message);
        if (onFatalFallback) onFatalFallback();
      }
    })();

    videoEl.play().catch(() => {});
  }

  // ─── Fallback: HLS via server-side ffmpeg (old iOS / non-MSE) ────────────
  // onFatalFallback is called when HLS encounters a fatal mid-stream error.
  async function startHlsPlayback(sRef, onFatalFallback) {
    const startRes = await fetch('/hls/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sRef }),
    });
    if (!startRes.ok) throw new Error(`HLS start failed: HTTP ${startRes.status}`);

    const startData = await startRes.json();
    hlsSessionId = startData.sessionId;
    const playlistUrl = startData.playlist;

    // Native HLS only for iOS Safari — it has no MSE support and can't run hls.js.
    // Desktop Safari, Edge, Chrome all have MediaSource → use hls.js for reliability.
    if (videoEl.canPlayType('application/vnd.apple.mpegurl') && !window.MediaSource) {
      videoEl.src = playlistUrl;
      videoEl.onerror = () => {
        console.warn('Native HLS error, trying mpegts fallback');
        videoEl.onerror = null;
        if (onFatalFallback) onFatalFallback();
      };
      await videoEl.play().catch(() => {});
      return;
    }

    // hls.js (Chrome, Firefox, Edge, …)
    if (window.Hls && window.Hls.isSupported()) {
      hlsPlayer = new window.Hls({
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 4,
        lowLatencyMode: true,
        backBufferLength: 0,
      });
      hlsPlayer.attachMedia(videoEl);
      hlsPlayer.on(window.Hls.Events.MEDIA_ATTACHED, () => {
        hlsPlayer.loadSource(playlistUrl);
      });
      hlsPlayer.on(window.Hls.Events.MANIFEST_PARSED, () => {
        videoEl.play().catch(() => {});
      });
      hlsPlayer.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (data?.fatal) {
          console.warn('HLS.js fatal error, trying mpegts fallback');
          if (onFatalFallback) onFatalFallback();
          else showVideoError('HLS playback error. Please retry channel.');
        }
      });
      return;
    }

    throw new Error('HLS not supported in this browser');
  }

  async function stopCurrentPlayback() {
    if (fmp4Abort) { fmp4Abort.abort(); fmp4Abort = null; }
    if (player) { try { player.destroy(); } catch {} player = null; }
    if (hlsPlayer) { try { hlsPlayer.destroy(); } catch {} hlsPlayer = null; }
    if (hlsSessionId) {
      try {
        await fetch('/hls/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: hlsSessionId }),
        });
      } catch {}
      hlsSessionId = null;
    }
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
  }

  // ─── mpegts fallback player ───────────────────────────────────────────────
  function tryMpegtsPlayback(sRef) {
    const mpegtsAvailable = typeof mpegts !== 'undefined' && mpegts.isSupported();
    if (!mpegtsAvailable) {
      showVideoError('Stream cannot be played on this browser. Try Chrome or Firefox.');
      return;
    }
    const streamUrl = `${window.location.origin}/stream/${encodeURIComponent(sRef)}`;
    player = mpegts.createPlayer({
      type: 'mpegts',
      url: streamUrl,
      isLive: true,
    }, {
      enableWorker: true,
      enableStashBuffer: false,
      stashInitialSize: 128,
      lazyLoad: false,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 1.5,
      liveBufferLatencyMinRemain: 0.15,
    });
    player.attachMediaElement(videoEl);
    player.load();
    player.play().catch(() => {});
    player.on(mpegts.Events.ERROR, (errType, errDetail) => {
      console.error('mpegts error:', errType, errDetail);
      bufferingSpinner.classList.remove('visible');
      if (errType === mpegts.ErrorTypes.MEDIA_ERROR) {
        showVideoError('Codec not supported — this channel may broadcast in HEVC/H.265. Try installing "HEVC Video Extensions" from the Microsoft Store, or use Google Chrome.');
      } else if (errType === mpegts.ErrorTypes.NETWORK_ERROR) {
        showVideoError('Stream unavailable — check that the receiver is on and reachable.');
      }
    });
  }

  // ─── Channel tuning & streaming ───────────────────────────────────────────
  async function tuneChannel(sRef, name, itemEl) {
    // Mark active
    document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
    if (itemEl) itemEl.classList.add('active');

    currentSRef = sRef;
    currentChannelName = name;

    videoOverlay.classList.add('hidden');
    bufferingSpinner.classList.add('visible');

    await stopCurrentPlayback();

    videoEl.onwaiting = () => bufferingSpinner.classList.add('visible');
    videoEl.onplaying = () => { bufferingSpinner.classList.remove('visible'); hideVideoError(); };
    videoEl.oncanplay = () => bufferingSpinner.classList.remove('visible');

    // Playback priority:
    // 1. fMP4 via MSE  — no disk I/O, works on all modern browsers + iOS 13+
    // 2. HLS           — file-based, fallback for old iOS without MSE
    // 3. mpegts.js     — direct TS pipe, fallback if both above fail
    if (fmp4Supported()) {
      try {
        await startFmp4Playback(sRef, () => tryMpegtsPlayback(sRef));
      } catch (err) {
        console.warn('fMP4 failed, trying mpegts:', err.message);
        tryMpegtsPlayback(sRef);
      }
    } else {
      // Old iOS Safari without MSE — use HLS
      try {
        await startHlsPlayback(sRef, () => tryMpegtsPlayback(sRef));
      } catch (hlsErr) {
        console.warn('HLS failed, trying mpegts:', hlsErr.message);
        tryMpegtsPlayback(sRef);
      }
    }

    // Load EPG for the selected channel
    loadEpgPanel(sRef, name);
    startEpgRefresh(sRef, name);

    // Schedule background EPG preload for the active bouquet
    const activeBouquet = bouquetSelect.value;
    if (activeBouquet) scheduleEpgPreload(activeBouquet);

    updatePip();
  }

  // ─── EPG Side Panel ───────────────────────────────────────────────────────
  async function loadEpgPanel(sRef, channelName) {
    epgContent.innerHTML = '<div class="epg-empty">Loading EPG…</div>';
    nowPlaying.style.display = 'none';

    try {
      const data = await apiFetch(`/api/epg?sRef=${encodeURIComponent(sRef)}`);
      const events = data.events || [];

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
          <div class="epg-event-title">${escHtml(decodeHtml(evt.title || '–'))}</div>
          ${evt.shortdesc ? `<div class="epg-event-desc">${escHtml(decodeHtml(evt.shortdesc))}</div>` : ''}
          <div class="epg-event-duration">${durMin} min</div>
        `;
        div.addEventListener('click', () => openEventModal(evt, channelName, sRef));
        epgContent.appendChild(div);

        if (isCurrent) {
          updateNowPlayingBar(channelName, evt, now);
          setTimeout(() => div.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 100);
        }
      });
    } catch (e) {
      epgContent.innerHTML = `<div class="epg-empty">Error: ${escHtml(e.message)}</div>`;
    }
  }

  function updateNowPlayingBar(channelName, evt, now) {
    nowPlaying.style.display = 'flex';
    npChannel.innerHTML = currentSRef
      ? `${piconImg(currentSRef)}<span>${escHtml(channelName)}</span>`
      : escHtml(channelName);
    npTitle.textContent = decodeHtml(evt.title || '');
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
    // Pre-select whatever is active in the player
    epgBouquetSelect.value = bouquetSelect.value;
  }

  // Also expose so preloadEpgForBouquet can call it before the overlay opens
  window._syncEpgBouquetSelect = syncEpgBouquetSelect;

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

  // Decode HTML entities returned by the OpenWebif API (e.g. &#x27; → ')
  function decodeHtml(str) {
    return String(str || '')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
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

  function showVideoError(msg) {
    stopCurrentPlayback().catch(() => {});
    bufferingSpinner.classList.remove('visible');
    videoOverlay.classList.remove('hidden');
    videoOverlay.querySelector('.overlay-icon').textContent = '⚠';
    videoOverlay.querySelector('.overlay-text').textContent = msg;
  }

  function hideVideoError() {
    videoOverlay.classList.add('hidden');
    videoOverlay.querySelector('.overlay-icon').textContent = '▶';
    videoOverlay.querySelector('.overlay-text').textContent = 'Select a channel';
  }

  // ─── Keyboard shortcuts ───────────────────────────────────────────────────
  // M=Mute  ↑↓=Channel up/down  ←→=Volume  PgUp/PgDn=Bouquet up/down
  function getChannelItems() {
    return [...channelList.querySelectorAll('.channel-item')];
  }

  function showOsd(text) {
    let osd = document.getElementById('kbOsd');
    if (!osd) {
      osd = document.createElement('div');
      osd.id = 'kbOsd';
      osd.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
        'background:rgba(0,0,0,.75);color:#fff;padding:8px 20px;border-radius:8px;' +
        'font-size:14px;font-weight:600;pointer-events:none;z-index:9999;transition:opacity .3s';
      document.body.appendChild(osd);
    }
    osd.textContent = text;
    osd.style.opacity = '1';
    clearTimeout(osd._t);
    osd._t = setTimeout(() => { osd.style.opacity = '0'; }, 1500);
  }

  document.addEventListener('keydown', e => {
    // Skip when typing in an input/textarea/select
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    // Skip when a modal/overlay is open
    if (eventModal.classList.contains('open')) return;
    if (epgOverlay.classList.contains('open')) return;

    switch (e.key) {
      case 'm':
      case 'M': {
        e.preventDefault();
        videoEl.muted = !videoEl.muted;
        showOsd(videoEl.muted ? '🔇 Mute' : '🔊 Unmute');
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        videoEl.volume = Math.max(0, +(videoEl.volume - 0.1).toFixed(1));
        showOsd(`Lautstärke: ${Math.round(videoEl.volume * 100)}%`);
        break;
      }
      case 'ArrowRight': {
        e.preventDefault();
        videoEl.volume = Math.min(1, +(videoEl.volume + 0.1).toFixed(1));
        showOsd(`Lautstärke: ${Math.round(videoEl.volume * 100)}%`);
        break;
      }
      case 'ArrowDown': {
        e.preventDefault();
        const items = getChannelItems();
        if (!items.length) break;
        const idx = items.findIndex(el => el.dataset.sref === currentSRef);
        const next = items[idx + 1] || items[0];
        next.click();
        next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const items = getChannelItems();
        if (!items.length) break;
        const idx = items.findIndex(el => el.dataset.sref === currentSRef);
        const prev = idx <= 0 ? items[items.length - 1] : items[idx - 1];
        prev.click();
        prev.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        break;
      }
      case 'PageDown': {
        e.preventDefault();
        const opts = [...bouquetSelect.options];
        const cur = bouquetSelect.selectedIndex;
        const next = cur < opts.length - 1 ? cur + 1 : 0;
        bouquetSelect.selectedIndex = next;
        bouquetSelect.dispatchEvent(new Event('change'));
        showOsd(`Bouquet: ${opts[next].text}`);
        break;
      }
      case 'PageUp': {
        e.preventDefault();
        const opts = [...bouquetSelect.options];
        const cur = bouquetSelect.selectedIndex;
        const prev = cur > 0 ? cur - 1 : opts.length - 1;
        bouquetSelect.selectedIndex = prev;
        bouquetSelect.dispatchEvent(new Event('change'));
        showOsd(`Bouquet: ${opts[prev].text}`);
        break;
      }
    }
  });

  // ─── Cleanup on page close ────────────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    if (fmp4Abort) fmp4Abort.abort();
    if (hlsSessionId) {
      const blob = new Blob(
        [JSON.stringify({ sessionId: hlsSessionId })],
        { type: 'application/json' }
      );
      navigator.sendBeacon('/hls/stop', blob);
    }
  });

  // ─── Log Panel ────────────────────────────────────────────────────────────
  const logPanel   = document.getElementById('logPanel');
  const logBody    = document.getElementById('logBody');
  const logToggle  = document.getElementById('logToggleBtn');
  const logCloseBtn = document.getElementById('logCloseBtn');
  const logClearBtn = document.getElementById('logClearBtn');
  let logSource = null;
  const MAX_LOG_LINES = 500;

  function connectLog() {
    if (logSource) return;
    logSource = new EventSource('/api/logs');
    logSource.onmessage = (e) => {
      try {
        const { ts, level, msg } = JSON.parse(e.data);
        const line = document.createElement('div');
        line.className = `log-line log-${level}`;
        const time = ts.slice(11, 19);
        line.innerHTML = `<span class="log-ts">${time}</span>${escHtml(msg)}`;
        logBody.appendChild(line);
        while (logBody.children.length > MAX_LOG_LINES) logBody.removeChild(logBody.firstChild);
        logBody.scrollTop = logBody.scrollHeight;
      } catch {}
    };
    logSource.onerror = () => {
      logSource.close();
      logSource = null;
      setTimeout(connectLog, 3000);
    };
  }

  function openLogPanel() {
    logPanel.style.display = 'flex';
    logToggle.classList.add('active');
    connectLog();
  }

  function closeLogPanel() {
    logPanel.style.display = 'none';
    logToggle.classList.remove('active');
    if (logSource) { logSource.close(); logSource = null; }
  }

  logToggle.addEventListener('click', () => {
    logPanel.style.display === 'none' ? openLogPanel() : closeLogPanel();
  });
  logCloseBtn.addEventListener('click', closeLogPanel);
  logClearBtn.addEventListener('click', () => { logBody.innerHTML = ''; });

  // ─── Boot ─────────────────────────────────────────────────────────────────
  loadBouquets();

  // Expose helpers for epg-timeline.js and bouquet-editor.js
  window._app = {
    apiFetch,
    escHtml,
    decodeHtml,
    fmtTime,
    fmtDateTime,
    openEventModal,
    tuneChannel,
    bouquetSelect,
    piconImg,
    get allBouquets() { return allBouquets; },
    channelCache,
    updatePip,
  };
})();
