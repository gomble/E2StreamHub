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
  // /api/epgbouquet only returns the CURRENT event per channel — useless for
  // a timeline. Load full schedules via /api/epg (/api/epgservice) per channel
  // in parallel batches so we get past + current + future events.
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

      // Fetch full EPG for all channels in parallel batches of 6
      const BATCH = 6;
      const eventsByRef = {};
      let done = 0;

      for (let i = 0; i < services.length; i += BATCH) {
        const batch = services.slice(i, i + BATCH);
        await Promise.all(batch.map(async svc => {
          try {
            const data = await window._app.apiFetch(`/api/epg?sRef=${encodeURIComponent(svc.servicereference)}`);
            eventsByRef[svc.servicereference] = data.events || [];
          } catch {
            eventsByRef[svc.servicereference] = [];
          }
          done++;
          const loading = epgGuide.querySelector('.epg-guide-loading');
          if (loading) loading.textContent = `Loading EPG (${done} / ${services.length})…`;
        }));
      }

      guideData = services.map(svc => ({
        name: svc.servicename,
        sRef: svc.servicereference,
        events: (eventsByRef[svc.servicereference] || [])
          .sort((a, b) => a.begin_timestamp - b.begin_timestamp),
      }));

      renderGuide();
    } catch (e) {
      epgGuide.innerHTML = `<div class="epg-guide-placeholder">Error: ${window._app.escHtml(e.message)}</div>`;
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

    // Map index → evt object so click handler can access the full event data
    const evtMap = [];

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
          data-evtidx="${evtMap.length}"
          title="${escAttr(window._app.decodeHtml(evt.title || ''))} (${fmtTime(startDate)}–${fmtTime(endDate)})">`;
        html += `<div class="epg-program-title">${window._app.escHtml(window._app.decodeHtml(evt.title || '–'))}</div>`;
        if (widthPx > 80) {
          html += `<div class="epg-program-time">${fmtTime(startDate)}–${fmtTime(endDate)}</div>`;
        }
        html += `</div>`;
        evtMap.push(evt);
      });

      html += `</div></div>`;  // .epg-programs-track + .epg-channel-row
    });

    html += `</div>`; // relative wrapper

    epgGuide.innerHTML = html;

    // Attach evt objects to program divs so the click handler can open the modal
    epgGuide.querySelectorAll('.epg-program[data-evtidx]').forEach(el => {
      el._evt = evtMap[parseInt(el.dataset.evtidx, 10)];
    });

    // ─── Event delegation ───────────────────────────────────────────────
    epgGuide.addEventListener('click', onGuideClick, { once: true });

    // Scroll to current time position
    scrollToNow(viewStartTs, viewEndTs, nowTs, totalMin);
  }

  function tuneFromOverlay(sRef, name) {
    // Close EPG overlay and switch to player
    document.getElementById('epgOverlay').classList.remove('open');
    document.getElementById('epgOverlay').setAttribute('aria-hidden', 'true');
    const sideItem = [...document.querySelectorAll('.channel-item')].find(el => el.dataset.sref === sRef) || null;
    window._app.tuneChannel(sRef, name, sideItem);
  }

  function onGuideClick(e) {
    // Always re-attach (we use { once: true } to avoid duplicate fires on re-render)
    const reattach = () => epgGuide.addEventListener('click', onGuideClick, { once: true });

    const program = e.target.closest('.epg-program');
    const label   = e.target.closest('.epg-channel-label');

    if (program) {
      // Show detail modal for this program block
      const sRef = program.dataset.sref;
      const name = program.dataset.name;
      const evt  = program._evt;
      if (evt) window._app.openEventModal(evt, name, sRef);
      reattach();
      return;
    }

    if (label) {
      // Channel label click → tune immediately
      tuneFromOverlay(label.dataset.sref, label.dataset.name);
      reattach();
      return;
    }

    reattach();
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
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDateTime(date) {
    return date.toLocaleString('en-GB', {
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
