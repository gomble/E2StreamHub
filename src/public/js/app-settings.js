/* ─── E2StreamHub – App Settings ───────────────────────────────────────── */

(function () {
  const overlay  = document.getElementById('appSettingsOverlay');
  const openBtn  = document.getElementById('appSettingsBtn');
  const closeBtn = document.getElementById('appSettingsCloseBtn');

  function api(url, opts) { return window._app.apiFetch(url, opts); }

  function open() {
    if (window._app?.closeAllOverlays) window._app.closeAllOverlays();
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    if (window._app?.updatePip) window._app.updatePip();
    loadSettings();
  }

  function close() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    if (window._app?.setActiveNav) window._app.setActiveNav('player');
    if (window._app?.updatePip) window._app.updatePip();
  }

  document.getElementById('asPipEnabled').addEventListener('change', function () {
    localStorage.setItem('pipEnabled', this.checked ? 'true' : 'false');
    if (window._app?.updatePip) window._app.updatePip();
  });

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });

  // ─── Load current settings ────────────────────────────────────────────
  async function loadSettings() {
    try {
      const data = await api('/api/appsettings');
      document.getElementById('asEnigmaHost').value  = data.ENIGMA2_HOST || '';
      document.getElementById('asEnigmaPort').value  = data.ENIGMA2_PORT || '';
      document.getElementById('asStreamPort').value  = data.ENIGMA2_STREAM_PORT || '';
      document.getElementById('asSshPort').value     = data.ENIGMA2_SSH_PORT || '';
      document.getElementById('asEnigmaUser').value  = data.ENIGMA2_USER || '';
      document.getElementById('asEnigmaPwd').value   = data.ENIGMA2_PASSWORD || '';
      document.getElementById('asStreamAuth').checked = data.ENIGMA2_STREAM_AUTH === 'true';
      document.getElementById('asTranscode').checked  = data.FFMPEG_FORCE_VIDEO_TRANSCODE === 'true';
      document.getElementById('asProbesize').value    = Math.round((parseInt(data.FFMPEG_PROBESIZE, 10) || 10000000) / 1000000);
      document.getElementById('asAnalyze').value      = Math.round((parseInt(data.FFMPEG_ANALYZEDURATION, 10) || 10000000) / 1000000);
      document.getElementById('asPreset').value       = data.FFMPEG_TRANSCODE_PRESET || 'ultrafast';
      document.getElementById('asHlsSeg').value       = data.HLS_SEGMENT_SECONDS || '';
      document.getElementById('asHlsList').value      = data.HLS_LIST_SIZE || '';
      document.getElementById('asNewUser').placeholder = data.APP_USERNAME || '(unverändert)';
      document.getElementById('asPipEnabled').checked = localStorage.getItem('pipEnabled') !== 'false';

      render2faStatus(data.has2fa);
    } catch (err) {
      showMsg('asSaveMsg', 'Fehler beim Laden: ' + err.message, true);
    }
  }

  // ─── 2FA Status ───────────────────────────────────────────────────────
  function render2faStatus(enabled) {
    const statusEl = document.getElementById('as2faStatus');
    const setupEl  = document.getElementById('as2faSetup');
    const disEl    = document.getElementById('as2faDisable');

    setupEl.style.display = 'none';
    disEl.style.display = 'none';

    if (enabled) {
      statusEl.innerHTML = '<span class="as-2fa-badge as-2fa-on">2FA aktiv</span>';
      disEl.style.display = '';
    } else {
      statusEl.innerHTML = '<span class="as-2fa-badge as-2fa-off">2FA inaktiv</span>' +
        ' <button class="btn-secondary" id="as2faEnableBtn">2FA einrichten</button>';
      document.getElementById('as2faEnableBtn').addEventListener('click', start2faSetup);
    }
  }

  async function start2faSetup() {
    try {
      const data = await api('/api/appsettings/2fa/setup', { method: 'POST' });
      document.getElementById('as2faSetup').style.display = '';

      const qrEl = document.getElementById('as2faQr');
      qrEl.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(data.otpauthUrl)}" alt="QR Code" width="200" height="200" />`;
      document.getElementById('as2faSecret').textContent = data.secret;
      document.getElementById('as2faToken').value = '';
      clearMsg('as2faMsg');
    } catch (err) {
      showMsg('as2faMsg', 'Fehler: ' + err.message, true);
    }
  }

  document.getElementById('as2faConfirm').addEventListener('click', async () => {
    const token = document.getElementById('as2faToken').value.trim();
    if (!token || token.length !== 6) {
      showMsg('as2faMsg', 'Bitte 6-stelligen Code eingeben', true);
      return;
    }
    try {
      await api('/api/appsettings/2fa/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      showMsg('as2faMsg', '2FA erfolgreich aktiviert!', false);
      setTimeout(() => loadSettings(), 1500);
    } catch (err) {
      showMsg('as2faMsg', err.message || 'Ungültiger Code', true);
    }
  });

  document.getElementById('as2faCancel').addEventListener('click', () => {
    document.getElementById('as2faSetup').style.display = 'none';
  });

  document.getElementById('as2faDisableBtn').addEventListener('click', async () => {
    const pwd = document.getElementById('as2faDisablePwd').value;
    if (!pwd) {
      showMsg('as2faDisableMsg', 'Passwort eingeben', true);
      return;
    }
    try {
      await api('/api/appsettings/2fa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      showMsg('as2faDisableMsg', '2FA deaktiviert', false);
      document.getElementById('as2faDisablePwd').value = '';
      setTimeout(() => loadSettings(), 1500);
    } catch (err) {
      showMsg('as2faDisableMsg', err.message || 'Passwort falsch', true);
    }
  });

  // ─── Password Change ──────────────────────────────────────────────────
  document.getElementById('asPwdSave').addEventListener('click', async () => {
    const cur  = document.getElementById('asCurPwd').value;
    const user = document.getElementById('asNewUser').value.trim();
    const pw1  = document.getElementById('asNewPwd').value;
    const pw2  = document.getElementById('asNewPwd2').value;

    if (!cur) { showMsg('asPwdMsg', 'Aktuelles Passwort eingeben', true); return; }
    if (!pw1) { showMsg('asPwdMsg', 'Neues Passwort eingeben', true); return; }
    if (pw1 !== pw2) { showMsg('asPwdMsg', 'Passwörter stimmen nicht überein', true); return; }
    if (pw1.length < 4) { showMsg('asPwdMsg', 'Mind. 4 Zeichen', true); return; }

    try {
      await api('/api/appsettings/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: cur, newUsername: user || undefined, newPassword: pw1 }),
      });
      showMsg('asPwdMsg', 'Gespeichert!', false);
      document.getElementById('asCurPwd').value = '';
      document.getElementById('asNewPwd').value = '';
      document.getElementById('asNewPwd2').value = '';
      document.getElementById('asNewUser').value = '';
    } catch (err) {
      showMsg('asPwdMsg', err.message || 'Fehler', true);
    }
  });

  // ─── Save All Settings ────────────────────────────────────────────────
  document.getElementById('asSaveAll').addEventListener('click', async () => {
    const payload = {
      ENIGMA2_HOST:     document.getElementById('asEnigmaHost').value.trim(),
      ENIGMA2_PORT:     document.getElementById('asEnigmaPort').value.trim(),
      ENIGMA2_STREAM_PORT: document.getElementById('asStreamPort').value.trim(),
      ENIGMA2_SSH_PORT: document.getElementById('asSshPort').value.trim(),
      ENIGMA2_USER:     document.getElementById('asEnigmaUser').value.trim(),
      ENIGMA2_PASSWORD: document.getElementById('asEnigmaPwd').value,
      ENIGMA2_STREAM_AUTH: document.getElementById('asStreamAuth').checked ? 'true' : 'false',
      FFMPEG_FORCE_VIDEO_TRANSCODE: document.getElementById('asTranscode').checked ? 'true' : 'false',
      FFMPEG_PROBESIZE: String(Math.round((parseFloat(document.getElementById('asProbesize').value) || 10) * 1000000)),
      FFMPEG_ANALYZEDURATION: String(Math.round((parseFloat(document.getElementById('asAnalyze').value) || 10) * 1000000)),
      FFMPEG_TRANSCODE_PRESET: document.getElementById('asPreset').value,
      HLS_SEGMENT_SECONDS: document.getElementById('asHlsSeg').value.trim(),
      HLS_LIST_SIZE: document.getElementById('asHlsList').value.trim(),
    };

    try {
      await api('/api/appsettings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showMsg('asSaveMsg', 'Einstellungen gespeichert!', false);
    } catch (err) {
      showMsg('asSaveMsg', 'Fehler: ' + err.message, true);
    }
  });

  // ─── Helpers ──────────────────────────────────────────────────────────
  function showMsg(id, text, isErr) {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = 'as-msg ' + (isErr ? 'as-msg-err' : 'as-msg-ok');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  function clearMsg(id) {
    const el = document.getElementById(id);
    el.textContent = '';
  }
})();
