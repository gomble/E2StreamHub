/* ─── E2StreamHub – EPG Timeline (TV Guide) ──────────────────────────────── */

(function () {
  const HOURS_VISIBLE = 3;       // hours shown in the viewport
  const PX_PER_MIN   = 4;        // pixels per minute (= epg-hour-w / 60)
  const HOUR_WIDTH   = PX_PER_MIN * 60; // must match CSS --epg-hour-w

  let viewStart = null;          // start of visible time window (Date)
  let guideData  = [];           // [{ name, sRef, events: [{...}] }]
  let currentBRef = null;

  // ─── Elements ─────────────────────────────────────────────────────────────
  const epgBouquetSelect = document.getElementById('epgBouquetSelect');
  const epgLoadBtn        = document.getElementById('epgLoadBtn');
  const epgPrevBtn        = document.getElementById('epgPrevBtn');
  const epgNextBtn        = document.getElementById('epgNextBtn');
  const epgNowBtn         = document.getElementById('epgNowBtn');
  const epgTimeRange      = document.getElementById('epgTimeRange');
  const epgGuide          = document.getElementById('epgGuide');
  const container         = document.querySelector('.epg-guide-container');

  // ─── Buttons ──────────────────────────────────────────────────────────────
  epgLoadBtn.addEventListener('click', () => {
    const bRef = epgBouquetSelect.value;
    if (!bRef) return;
    currentBRef = bRef;
    resetViewToNow();
    loadAndRender(bRef);
  });

  epgPrevBtn.addEventListener('click', () => shiftView(-90));
  epgNextBtn.addEventListener('click', () => shiftView(90));
  epgNowBtn.addEventListener('click', () => { resetViewToNow(); renderGuide(); });

  function shiftView(minutes) {
    viewStart = new Date(viewStart.getTime() + minutes * 60000);
    renderGuide();
  }

  function resetViewToNow() {
    const now = new Date();
    // Snap to 30-minute slot
    const mins = now.getMinutes();
    const snapped = mins < 30 ? 0 : 30;
    viewStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
                         now.getHours(), snapped, 0, 0);
  }

  // ─── Load EPG ─────────────────────────────────────────────────────────────
  async function loadAndRender(bRef) {
    epgGuide.innerHTML = '<div class="epg-guide-loading">EPG wird geladen…</div>';

    try {
      // Step 1: Get services for the bouquet
      const svcData = await window._app.apiFetch(`/api/services?sRef=${encodeURIComponent(bRef)}`);
      const services = (svcData.services || []).slice(0, 50); // limit to 50 channels

      if (services.length === 0) {
        epgGuide.innerHTML = '<div class="epg-guide-placeholder">Keine Kanäle im Bouquet</div>';
        return;
      }

      // Step 2: Try bulk EPG endpoint first, fall back to per-channel
      let eventsByRef = {};
      try {
        const bulkData = await window._app.apiFetch(`/api/epgbouquet?bRef=${encodeURIComponent(bRef)}`);
        const bulkEvents = bulkData.events || [];
        bulkEvents.forEach(evt => {
          const ref = evt.sref || evt.servicereference;
          if (!ref) return;
          if (!eventsByRef[ref]) eventsByRef[ref] = [];
          eventsByRef[ref].push(evt);
        });
      } catch {
        // Fallback: load EPG per channel (slower)
        for (const svc of services) {
          try {
            const epgData = await window._app.apiFetch(`/api/epg?sRef=${encodeURIComponent(svc.servicereference)}`);
            eventsByRef[svc.servicereference] = epgData.events || [];
          } catch { eventsByRef[svc.servicereference] = []; }
        }
      }

      // Step 3: Build guide data
      guideData = services.map(svc => ({
        name: svc.servicename,
        sRef: svc.servicereference,
        events: (eventsByRef[svc.servicereference] || []).sort((a, b) => a.begin_timestamp - b.begin_timestamp),
      }));

      renderGuide();
    } catch (e) {
      epgGuide.innerHTML = `<div class="epg-guide-placeholder">Fehler: ${window._app.escHtml(e.message)}</div>`;
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  function renderGuide() {
    if (!viewStart || guideData.length === 0) return;

    const viewEnd   = new Date(viewStart.getTime() + HOURS_VISIBLE * 3600000);
    const viewStartTs = viewStart.getTime() / 1000;
    const viewEndTs   = viewEnd.getTime() / 1000;
    const totalMin    = HOURS_VISIBLE * 60;
    const nowTs       = Date.now() / 1000;

    // Update time range display
    epgTimeRange.textContent = `${fmtDateTime(viewStart)} – ${fmtDateTime(viewEnd)}`;

    // Build time slots header (30-minute intervals)
    const timeSlots = [];
    let slotTime = new Date(viewStart);
    while (slotTime < viewEnd) {
      timeSlots.push(new Date(slotTime));
      slotTime = new Date(slotTime.getTime() + 30 * 60000);
    }

    // Assemble HTML
    let html = '';

    // Time header
    html += `<div class="epg-time-header">`;
    html += `<div class="epg-time-header-spacer"></div>`;
    timeSlots.forEach(ts => {
      html += `<div class="epg-time-slot">${fmtTime(ts)}</div>`;
    });
    html += `</div>`;

    // Channel rows
    html += `<div style="position:relative">`;

    // Now-line
    if (nowTs >= viewStartTs && nowTs <= viewEndTs) {
      const nowPct = ((nowTs - viewStartTs) / (totalMin * 60)) * 100;
      const leftPx = HOUR_WIDTH_OFFSET + ((nowTs - viewStartTs) / 60) * PX_PER_MIN;
      html += `<div class="epg-now-line" style="left:${Math.round(leftPx + epgChannelW())}px"></div>`;
    }

    guideData.forEach(ch => {
      html += `<div class="epg-channel-row">`;
      html += `<div class="epg-channel-label" data-sref="${escAttr(ch.sRef)}" data-name="${escAttr(ch.name)}" title="${escAttr(ch.name)}">${window._app.escHtml(ch.name)}</div>`;
      html += `<div class="epg-programs-track" style="width:${totalMin * PX_PER_MIN}px;min-width:${totalMin * PX_PER_MIN}px">`;

      ch.events.forEach(evt => {
        const evtStart = evt.begin_timestamp;
        const evtEnd   = evtStart + evt.duration_sec;

        // Skip events completely outside view
        if (evtEnd <= viewStartTs || evtStart >= viewEndTs) return;

        const clampedStart = Math.max(evtStart, viewStartTs);
        const clampedEnd   = Math.min(evtEnd,   viewEndTs);
        const leftMin  = (clampedStart - viewStartTs) / 60;
        const widthMin = (clampedEnd - clampedStart) / 60;
        const leftPx   = Math.round(leftMin  * PX_PER_MIN);
        const widthPx  = Math.max(2, Math.round(widthMin * PX_PER_MIN) - 2);
        const isCurrent = evtStart <= nowTs && evtEnd > nowTs;
        const startDate = new Date(evtStart * 1000);
        const endDate   = new Date(evtEnd   * 1000);

        html += `<div class="epg-program${isCurrent ? ' current-prog' : ''}"
          style="left:${leftPx}px;width:${widthPx}px"
          data-sref="${escAttr(ch.sRef)}"
          data-name="${escAttr(ch.name)}"
          title="${escAttr(evt.title || '')} (${fmtTime(startDate)}–${fmtTime(endDate)})">`;
        html += `<div class="epg-program-title">${window._app.escHtml(evt.title || '–')}</div>`;
        if (widthPx > 80) {
          html += `<div class="epg-program-time">${fmtTime(startDate)}–${fmtTime(endDate)}</div>`;
        }
        html += `</div>`;
      });

      html += `</div></div>`;  // .epg-programs-track + .epg-channel-row
    });

    html += `</div>`; // relative wrapper

    epgGuide.innerHTML = html;

    // ─── Event delegation ───────────────────────────────────────────────
    epgGuide.addEventListener('click', onGuideClick, { once: true });

    // Scroll to current time position
    scrollToNow(viewStartTs, viewEndTs, nowTs, totalMin);
  }

  function onGuideClick(e) {
    const target = e.target.closest('[data-sref]');
    if (!target) {
      epgGuide.addEventListener('click', onGuideClick, { once: true });
      return;
    }
    const sRef = target.dataset.sref;
    const name = target.dataset.name;
    if (!sRef) {
      epgGuide.addEventListener('click', onGuideClick, { once: true });
      return;
    }

    // Switch to player view and tune
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelector('[data-view="player"]').classList.add('active');
    document.getElementById('viewPlayer').classList.add('active');

    // Find channel item in sidebar and select it
    const sideItem = [...document.querySelectorAll('.channel-item')].find(el => el.dataset.sref === sRef) || null;
    window._app.tuneChannel(sRef, name, sideItem);
  }

  function scrollToNow(viewStartTs, viewEndTs, nowTs, totalMin) {
    if (nowTs < viewStartTs || nowTs > viewEndTs) return;
    const channelW = epgChannelW();
    const nowPx = channelW + ((nowTs - viewStartTs) / 60) * PX_PER_MIN;
    const containerW = container ? container.clientWidth : 800;
    const scrollLeft = Math.max(0, nowPx - containerW * 0.3);
    if (container) container.scrollLeft = scrollLeft;
  }

  function epgChannelW() {
    return parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--epg-channel-w') || '140', 10);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function fmtTime(date) {
    return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDateTime(date) {
    return date.toLocaleString('de-DE', {
      weekday: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  function escAttr(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  const HOUR_WIDTH_OFFSET = 0; // unused placeholder

})();
