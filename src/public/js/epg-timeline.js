/* ─── E2StreamHub – EPG Timeline (TV Guide) ──────────────────────────────── */

(function () {
  // Zoom = how many hours fit in the visible container width.
  // PX_PER_MIN is derived at render time from the container width and zoom level.
  let hoursVisible = 3;            // controlled by #epgZoomSelect
  let guideData    = [];           // [{ name, sRef, events: [{...}] }]
  let rangeStartTs = 0;            // unix ts of the leftmost rendered column
  let rangeTotalMin = 0;           // total minutes rendered

  // ─── Elements ─────────────────────────────────────────────────────────────
  const epgBouquetSelect = document.getElementById('epgBouquetSelect');
  const epgLoadBtn        = document.getElementById('epgLoadBtn');
  const epgPrevBtn        = document.getElementById('epgPrevBtn');
  const epgNextBtn        = document.getElementById('epgNextBtn');
  const epgNowBtn         = document.getElementById('epgNowBtn');
  const epgZoomSelect     = document.getElementById('epgZoomSelect');
  const epgTimeRange      = document.getElementById('epgTimeRange');
  const epgGuide          = document.getElementById('epgGuide');
  const container         = document.querySelector('.epg-guide-container');

  // ─── Controls ─────────────────────────────────────────────────────────────
  epgLoadBtn.addEventListener('click', () => {
    const bRef = epgBouquetSelect.value;
    if (!bRef) return;
    loadAndRender(bRef);
  });

  epgZoomSelect.addEventListener('change', () => {
    hoursVisible = parseInt(epgZoomSelect.value, 10);
    if (guideData.length > 0) {
      renderGuide();
      scrollToNow();
    }
  });

  // ◀/▶ scroll the container by one viewport width
  epgPrevBtn.addEventListener('click', () => {
    if (container) container.scrollLeft -= container.clientWidth * 0.8;
  });
  epgNextBtn.addEventListener('click', () => {
    if (container) container.scrollLeft += container.clientWidth * 0.8;
  });
  epgNowBtn.addEventListener('click', scrollToNow);

  // ─── Load EPG ─────────────────────────────────────────────────────────────
  // /api/epgbouquet only returns the CURRENT event — useless for a full timeline.
  // Load full schedules per channel in parallel batches.
  async function loadAndRender(bRef) {
    epgGuide.innerHTML = '<div class="epg-guide-loading">Loading channels…</div>';

    try {
      const svcData = await window._app.apiFetch(`/api/services?sRef=${encodeURIComponent(bRef)}`);
      const services = (svcData.services || []).slice(0, 50);

      if (services.length === 0) {
        epgGuide.innerHTML = '<div class="epg-guide-placeholder">No channels in bouquet</div>';
        return;
      }

      epgGuide.innerHTML = `<div class="epg-guide-loading">Loading EPG (0 / ${services.length})…</div>`;

      const BATCH = 6;
      const eventsByRef = {};
      let done = 0;
      const cache = window._epgCache || {};

      for (let i = 0; i < services.length; i += BATCH) {
        const batch = services.slice(i, i + BATCH);
        await Promise.all(batch.map(async svc => {
          const sref = svc.servicereference;
          // Use preloaded cache if available — avoids double-fetching
          if (cache[sref]) {
            eventsByRef[sref] = cache[sref];
          } else {
            try {
              const data = await window._app.apiFetch(`/api/epg?sRef=${encodeURIComponent(sref)}`);
              eventsByRef[sref] = data.events || [];
              cache[sref] = eventsByRef[sref]; // store back
            } catch {
              eventsByRef[sref] = [];
            }
          }
          done++;
          const loading = epgGuide.querySelector('.epg-guide-loading');
          if (loading) loading.textContent = `Loading EPG (${done} / ${services.length})…`;
        }));
      }
      window._epgCache = cache;

      guideData = services.map(svc => ({
        name: svc.servicename,
        sRef: svc.servicereference,
        events: (eventsByRef[svc.servicereference] || [])
          .sort((a, b) => a.begin_timestamp - b.begin_timestamp),
      }));

      renderGuide();
      scrollToNow();
    } catch (e) {
      epgGuide.innerHTML = `<div class="epg-guide-placeholder">Error: ${window._app.escHtml(e.message)}</div>`;
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  function renderGuide() {
    if (guideData.length === 0) return;

    // ── Determine full data range ──────────────────────────────────────────
    let minTs = Infinity, maxTs = -Infinity;
    guideData.forEach(ch => {
      ch.events.forEach(evt => {
        minTs = Math.min(minTs, evt.begin_timestamp);
        maxTs = Math.max(maxTs, evt.begin_timestamp + evt.duration_sec);
      });
    });
    if (minTs === Infinity) return;

    // Snap range start down to the previous 30-min boundary
    minTs = Math.floor(minTs / 1800) * 1800;
    // Snap range end up to the next 30-min boundary
    maxTs = Math.ceil(maxTs / 1800) * 1800;

    rangeStartTs  = minTs;
    rangeTotalMin = (maxTs - minTs) / 60;

    // ── PX_PER_MIN from zoom ───────────────────────────────────────────────
    // Fit `hoursVisible` hours into the container width minus the channel label column.
    const channelW   = epgChannelW();
    const trackW     = (container ? container.clientWidth : 900) - channelW;
    const pxPerMin   = Math.max(2, trackW / (hoursVisible * 60));
    const totalPx    = Math.round(rangeTotalMin * pxPerMin);

    const nowTs      = Date.now() / 1000;

    // ── Time header (30-min slots) ─────────────────────────────────────────
    epgTimeRange.textContent =
      `${fmtDateTime(new Date(minTs * 1000))} – ${fmtDateTime(new Date(maxTs * 1000))}`;

    const evtMap = [];
    let html = '';

    html += `<div class="epg-time-header">`;
    html += `<div class="epg-time-header-spacer"></div>`;
    html += `<div class="epg-time-header-track" style="width:${totalPx}px;min-width:${totalPx}px">`;
    for (let ts = minTs; ts < maxTs; ts += 1800) {
      const leftPx = Math.round(((ts - minTs) / 60) * pxPerMin);
      const slotW  = Math.round(30 * pxPerMin);
      html += `<div class="epg-time-slot" style="left:${leftPx}px;width:${slotW}px">${fmtTime(new Date(ts * 1000))}</div>`;
    }
    html += `</div></div>`;

    // ── Channel rows ───────────────────────────────────────────────────────
    html += `<div style="position:relative">`;

    // Now-line
    if (nowTs >= minTs && nowTs <= maxTs) {
      const nowLeft = Math.round(((nowTs - minTs) / 60) * pxPerMin) + channelW;
      html += `<div class="epg-now-line" style="left:${nowLeft}px"></div>`;
    }

    guideData.forEach(ch => {
      html += `<div class="epg-channel-row">`;
      const piconSrc = `/picon/${encodeURIComponent(ch.sRef)}`;
      html += `<div class="epg-channel-label" data-sref="${escAttr(ch.sRef)}" data-name="${escAttr(ch.name)}" title="${escAttr(ch.name)}"><img class="picon" src="${piconSrc}" alt="" loading="lazy" onerror="this.style.display='none'"><span class="epg-ch-name">${window._app.escHtml(ch.name)}</span></div>`;
      html += `<div class="epg-programs-track" style="width:${totalPx}px;min-width:${totalPx}px;position:relative">`;

      ch.events.forEach(evt => {
        const evtStart = evt.begin_timestamp;
        const evtEnd   = evtStart + evt.duration_sec;
        if (evtEnd <= minTs || evtStart >= maxTs) return;

        const leftMin  = (Math.max(evtStart, minTs) - minTs) / 60;
        const widthMin = (Math.min(evtEnd, maxTs) - Math.max(evtStart, minTs)) / 60;
        const leftPx   = Math.round(leftMin  * pxPerMin);
        const widthPx  = Math.max(2, Math.round(widthMin * pxPerMin) - 2);
        const isCurrent = evtStart <= nowTs && evtEnd > nowTs;
        const startDate = new Date(evtStart * 1000);
        const endDate   = new Date(evtEnd * 1000);

        html += `<div class="epg-program${isCurrent ? ' current-prog' : ''}"
          style="left:${leftPx}px;width:${widthPx}px"
          data-sref="${escAttr(ch.sRef)}"
          data-name="${escAttr(ch.name)}"
          data-evtidx="${evtMap.length}"
          title="${escAttr(window._app.decodeHtml(evt.title || ''))} (${fmtTime(startDate)}–${fmtTime(endDate)})">`;
        html += `<div class="epg-program-title">${window._app.escHtml(window._app.decodeHtml(evt.title || '–'))}</div>`;
        if (widthPx > 80) {
          html += `<div class="epg-program-time">${fmtTime(startDate)}–${fmtTime(endDate)}</div>`;
        }
        html += `</div>`;
        evtMap.push(evt);
      });

      html += `</div></div>`;
    });

    html += `</div>`;

    epgGuide.innerHTML = html;

    epgGuide.querySelectorAll('.epg-program[data-evtidx]').forEach(el => {
      el._evt = evtMap[parseInt(el.dataset.evtidx, 10)];
    });

    epgGuide.addEventListener('click', onGuideClick, { once: true });
  }

  // ─── Scroll to now ────────────────────────────────────────────────────────
  function scrollToNow() {
    if (!container || !rangeStartTs) return;
    const channelW = epgChannelW();
    const trackW   = container.clientWidth - channelW;
    const pxPerMin = Math.max(2, trackW / (hoursVisible * 60));
    const nowTs    = Date.now() / 1000;
    const nowPx    = channelW + Math.round(((nowTs - rangeStartTs) / 60) * pxPerMin);
    // Put "now" at 25% from the left edge
    container.scrollLeft = Math.max(0, nowPx - container.clientWidth * 0.25);
  }

  // ─── Click handling ───────────────────────────────────────────────────────
  function tuneFromOverlay(sRef, name) {
    document.getElementById('epgOverlay').classList.remove('open');
    document.getElementById('epgOverlay').setAttribute('aria-hidden', 'true');
    const sideItem = [...document.querySelectorAll('.channel-item')].find(el => el.dataset.sref === sRef) || null;
    window._app.tuneChannel(sRef, name, sideItem);
  }

  function onGuideClick(e) {
    const reattach = () => epgGuide.addEventListener('click', onGuideClick, { once: true });

    const program = e.target.closest('.epg-program');
    const label   = e.target.closest('.epg-channel-label');

    if (program) {
      const evt  = program._evt;
      if (evt) window._app.openEventModal(evt, program.dataset.name, program.dataset.sref);
      reattach();
      return;
    }
    if (label) {
      tuneFromOverlay(label.dataset.sref, label.dataset.name);
      reattach();
      return;
    }
    reattach();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function epgChannelW() {
    return parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--epg-channel-w') || '140', 10);
  }

  function fmtTime(date) {
    return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDateTime(date) {
    return date.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function escAttr(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

})();
