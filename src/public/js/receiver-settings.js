/* ─── E2StreamHub – Receiver Settings ────────────────────────────────────── */

(function () {
  const overlay  = document.getElementById('receiverOverlay');
  const closeBtn = document.getElementById('receiverCloseBtn');
  let signalTimer = null;

  function open() {
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    if (window._app?.updatePip) window._app.updatePip();
    loadAll();
    clearInterval(signalTimer);
    signalTimer = setInterval(loadSignal, 5000);
  }

  function close() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    clearInterval(signalTimer);
    signalTimer = null;
    if (window._app?.updatePip) window._app.updatePip();
  }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });
  window._receiverOpen = open;

  function api(url) { return window._app.apiFetch(url); }
  function esc(s) { return window._app.escHtml(s); }

  // ─── Load all sections ──────────────────────────────────────────────────
  function loadAll() {
    loadAbout();
    loadSignal();
    loadVolume();
    loadSleepTimer();
    loadTimers();
    loadSettings();
  }

  // ─── Receiver Info ──────────────────────────────────────────────────────
  async function loadAbout() {
    try {
      const data = await api('/api/about');
      const info = data.info || {};
      const hdd  = (data.hdd || [])[0];
      const ifaces = data.ifaces || [];

      document.getElementById('rcvModel').textContent = info.brand
        ? `${info.brand} ${info.model || ''}`.trim()
        : info.model || '–';
      document.getElementById('rcvImage').textContent = info.imagedistro
        ? `${info.imagedistro} ${info.imageversion || ''}`.trim()
        : '–';
      document.getElementById('rcvEnigmaVer').textContent = info.enigmaver || '–';
      document.getElementById('rcvWebifVer').textContent  = info.webifver || '–';
      document.getElementById('rcvKernel').textContent     = info.kernelver || '–';

      const tuners = (data.tuners || []).map(t => t.name || t.type).filter(Boolean);
      document.getElementById('rcvTuners').textContent = tuners.length
        ? `${tuners.length} (${tuners.join(', ')})`
        : '–';

      if (ifaces.length > 0) {
        const net = ifaces.map(i => `${i.name || ''}: ${i.ip || '?'}`).join(', ');
        document.getElementById('rcvNetwork').textContent = net;
      }

      if (hdd) {
        const free = hdd.free ? `${hdd.free}` : '';
        const cap  = hdd.capacity ? `${hdd.capacity}` : '';
        document.getElementById('rcvHdd').textContent = free && cap ? `${free} frei / ${cap}` : free || cap || '–';
      }

      if (info.uptime) {
        document.getElementById('rcvUptime').textContent = info.uptime;
      }
    } catch {
      document.getElementById('rcvModel').textContent = 'Nicht erreichbar';
    }

    // Current channel from statusinfo
    try {
      const st = await api('/api/statusinfo');
      const name = st.currservice_name || st.currservice?.name;
      document.getElementById('rcvCurrentCh').textContent = name || '–';
    } catch {}
  }

  // ─── Signal ─────────────────────────────────────────────────────────────
  async function loadSignal() {
    if (!overlay.classList.contains('open')) return;
    try {
      const data = await api('/api/signal');
      const snr = parseInt(data.snr || '0', 10);
      const agc = parseInt(data.agc || '0', 10);
      const snrDb = data.snrdb || '';
      const ber = data.ber || '0';

      document.getElementById('rcvSnrBar').style.width = `${snr}%`;
      document.getElementById('rcvSnrVal').textContent = snrDb ? snrDb : `${snr}%`;
      document.getElementById('rcvAgcBar').style.width = `${agc}%`;
      document.getElementById('rcvAgcVal').textContent = `${agc}%`;
      document.getElementById('rcvBerVal').textContent = ber;
    } catch {
      document.getElementById('rcvSnrVal').textContent = '–';
      document.getElementById('rcvAgcVal').textContent = '–';
    }
  }

  // ─── Power Controls ─────────────────────────────────────────────────────
  document.querySelectorAll('[data-power]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const state = btn.dataset.power;
      const labels = { '0': 'Standby', '1': 'Deep Standby', '2': 'Neustart', '3': 'GUI Neustart' };
      if ((state === '1' || state === '2' || state === '3') && !confirm(`${labels[state]} wirklich ausführen?`)) return;
      try {
        await api(`/api/powerstate?newstate=${state}`);
        showToast(`${labels[state]} gesendet`);
      } catch (err) {
        showToast(`Fehler: ${err.message}`);
      }
    });
  });

  // ─── Volume ─────────────────────────────────────────────────────────────
  const volFill = document.getElementById('rcvVolFill');
  const volVal  = document.getElementById('rcvVolVal');
  const muteBtn = document.getElementById('rcvMuteBtn');
  let currentVol = 50;
  let isMuted = false;

  async function loadVolume() {
    try {
      const data = await api('/api/vol');
      currentVol = data.current !== undefined ? parseInt(data.current, 10) : 50;
      isMuted = !!data.ismute;
      updateVolUi();
    } catch {}
  }

  function updateVolUi() {
    volFill.style.width = `${currentVol}%`;
    volVal.textContent = isMuted ? 'MUTE' : `${currentVol}%`;
    muteBtn.textContent = isMuted ? '🔇' : '🔊';
  }

  async function setVol(val) {
    try {
      const data = await api(`/api/vol?set=set${val}`);
      currentVol = data.current !== undefined ? parseInt(data.current, 10) : val;
      isMuted = !!data.ismute;
      updateVolUi();
    } catch {}
  }

  document.getElementById('rcvVolDown').addEventListener('click', () => {
    setVol(Math.max(0, currentVol - 5));
  });
  document.getElementById('rcvVolUp').addEventListener('click', () => {
    setVol(Math.min(100, currentVol + 5));
  });
  muteBtn.addEventListener('click', async () => {
    try {
      const data = await api('/api/vol?set=mute');
      isMuted = !!data.ismute;
      updateVolUi();
    } catch {}
  });

  document.querySelector('.rcv-vol-track').addEventListener('click', e => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.round(((e.clientX - rect.left) / rect.width) * 100);
    setVol(Math.max(0, Math.min(100, pct)));
  });

  // ─── Sleep Timer ────────────────────────────────────────────────────────
  const sleepStatus = document.getElementById('rcvSleepStatus');

  async function loadSleepTimer() {
    try {
      const data = await api('/api/sleeptimer?cmd=get');
      if (data.enabled) {
        sleepStatus.textContent = `Aktiv: ${data.minutes || '?'} min → ${data.action || 'standby'}`;
      } else {
        sleepStatus.textContent = 'Inaktiv';
      }
    } catch {
      sleepStatus.textContent = '';
    }
  }

  document.getElementById('rcvSleepSet').addEventListener('click', async () => {
    const time = document.getElementById('rcvSleepTime').value;
    const action = document.getElementById('rcvSleepAction').value;
    try {
      await api(`/api/sleeptimer?cmd=set&time=${time}&action=${action}&enabled=True`);
      showToast(`Sleep Timer: ${time} min`);
      loadSleepTimer();
    } catch (err) {
      showToast(`Fehler: ${err.message}`);
    }
  });

  document.getElementById('rcvSleepOff').addEventListener('click', async () => {
    try {
      await api('/api/sleeptimer?cmd=set&enabled=False');
      showToast('Sleep Timer deaktiviert');
      loadSleepTimer();
    } catch (err) {
      showToast(`Fehler: ${err.message}`);
    }
  });

  // ─── Remote Control ─────────────────────────────────────────────────────
  document.querySelectorAll('[data-rc]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.style.opacity = '0.5';
      try {
        await api(`/api/remotecontrol?command=${btn.dataset.rc}`);
      } catch {}
      setTimeout(() => { btn.style.opacity = ''; }, 200);
    });
  });

  // ─── Send Message ───────────────────────────────────────────────────────
  document.getElementById('rcvMsgSend').addEventListener('click', async () => {
    const text = document.getElementById('rcvMsgInput').value.trim();
    if (!text) return;
    const type = document.getElementById('rcvMsgType').value;
    try {
      await api(`/api/message?text=${encodeURIComponent(text)}&type=${type}&timeout=10`);
      showToast('Nachricht gesendet');
      document.getElementById('rcvMsgInput').value = '';
    } catch (err) {
      showToast(`Fehler: ${err.message}`);
    }
  });

  // ─── Timers ─────────────────────────────────────────────────────────────
  document.getElementById('rcvTimerRefresh').addEventListener('click', loadTimers);
  document.getElementById('rcvTimerCleanup').addEventListener('click', async () => {
    try {
      await api('/api/timercleanup');
      showToast('Abgelaufene Timer gelöscht');
      loadTimers();
    } catch (err) {
      showToast(`Fehler: ${err.message}`);
    }
  });

  async function loadTimers() {
    const list = document.getElementById('rcvTimerList');
    try {
      const data = await api('/api/timerlist');
      const timers = data.timers || [];
      if (timers.length === 0) {
        list.innerHTML = '<div class="list-placeholder">Keine Timer vorhanden</div>';
        return;
      }

      list.innerHTML = '';
      timers.forEach(t => {
        const begin = new Date(t.begin * 1000);
        const end   = new Date(t.end * 1000);
        const fmt   = d => d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const now   = Date.now() / 1000;

        let stateClass = 'rcv-timer-waiting';
        let stateLabel = 'Geplant';
        if (t.state === 2 || (t.begin <= now && t.end > now)) {
          stateClass = 'rcv-timer-running';
          stateLabel = 'Läuft';
        } else if (t.state === 3 || t.end < now) {
          stateClass = 'rcv-timer-done';
          stateLabel = 'Fertig';
        }
        if (t.disabled) stateLabel = 'Deaktiviert';

        const icon = t.disabled ? '⏸' : (stateLabel === 'Läuft' ? '🔴' : '⏰');

        const item = document.createElement('div');
        item.className = 'rcv-timer-item';
        item.innerHTML = `
          <span class="rcv-timer-icon">${icon}</span>
          <div class="rcv-timer-info">
            <div class="rcv-timer-name">${esc(t.name || t.servicename || '–')}</div>
            <div class="rcv-timer-meta">${esc(t.servicename || '')} · ${fmt(begin)} – ${fmt(end)}</div>
          </div>
          <div class="rcv-timer-btns">
            <button class="rcv-timer-toggle" title="${t.disabled ? 'Aktivieren' : 'Deaktivieren'}">${t.disabled ? '▶' : '⏸'}</button>
            <button class="rcv-timer-del" title="Löschen">✕</button>
          </div>
          <span class="rcv-timer-state ${stateClass}">${stateLabel}</span>
        `;

        item.querySelector('.rcv-timer-toggle').addEventListener('click', async () => {
          try {
            await api(`/api/timertoggle?sRef=${encodeURIComponent(t.servicereference)}&begin=${t.begin}&end=${t.end}`);
            showToast('Timer umgeschaltet');
            loadTimers();
          } catch (err) { showToast(`Fehler: ${err.message}`); }
        });

        item.querySelector('.rcv-timer-del').addEventListener('click', async () => {
          if (!confirm(`Timer "${t.name || t.servicename}" löschen?`)) return;
          try {
            await api(`/api/timerdelete?sRef=${encodeURIComponent(t.servicereference)}&begin=${t.begin}&end=${t.end}`);
            showToast('Timer gelöscht');
            loadTimers();
          } catch (err) { showToast(`Fehler: ${err.message}`); }
        });

        list.appendChild(item);
      });
    } catch (err) {
      list.innerHTML = `<div class="list-placeholder">Fehler: ${esc(err.message)}</div>`;
    }
  }

  // ─── Enigma2 Settings ───────────────────────────────────────────────────
  let allSettings = [];

  async function loadSettings() {
    const container = document.getElementById('rcvSettingsList');
    try {
      const data = await api('/api/settings');
      allSettings = data.settings || [];
      if (allSettings.length === 0) {
        container.innerHTML = '<div class="list-placeholder">Keine Einstellungen verfügbar</div>';
        return;
      }

      renderSettings(allSettings, container);
    } catch (err) {
      container.innerHTML = `<div class="list-placeholder">Fehler: ${esc(err.message)}</div>`;
    }
  }

  function renderSettings(settings, container) {
    container.innerHTML = '';

    // Search filter
    const filter = document.createElement('input');
    filter.className = 'channel-search rcv-settings-filter';
    filter.type = 'search';
    filter.placeholder = 'Einstellung suchen…';
    filter.addEventListener('input', () => {
      const q = filter.value.toLowerCase();
      const filtered = q ? allSettings.filter(s =>
        (s.key || s[0] || '').toLowerCase().includes(q) ||
        (s.value || s[1] || '').toLowerCase().includes(q)
      ) : allSettings;
      renderSettingItems(filtered, listEl);
    });
    container.appendChild(filter);

    const listEl = document.createElement('div');
    listEl.className = 'rcv-settings-list';
    container.appendChild(listEl);

    renderSettingItems(settings, listEl);
  }

  function renderSettingItems(settings, listEl) {
    listEl.innerHTML = '';
    settings.slice(0, 200).forEach(s => {
      const key = s.key || s[0] || '';
      const val = s.value !== undefined ? s.value : (s[1] || '');

      const item = document.createElement('div');
      item.className = 'rcv-setting-item';
      item.innerHTML = `
        <span class="rcv-setting-key" title="${esc(key)}">${esc(key)}</span>
        <span class="rcv-setting-val" title="${esc(String(val))}">${esc(String(val))}</span>
      `;
      listEl.appendChild(item);
    });

    if (settings.length > 200) {
      const more = document.createElement('div');
      more.className = 'list-placeholder';
      more.textContent = `… und ${settings.length - 200} weitere (Suchfilter nutzen)`;
      listEl.appendChild(more);
    }
  }

  // ─── Toast helper ───────────────────────────────────────────────────────
  function showToast(text) {
    let toast = document.getElementById('rcvToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'rcvToast';
      toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
        'background:rgba(0,0,0,.8);color:#fff;padding:8px 20px;border-radius:8px;' +
        'font-size:13px;font-weight:600;pointer-events:none;z-index:9999;transition:opacity .3s';
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
  }

})();
