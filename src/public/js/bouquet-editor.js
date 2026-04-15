/* ─── E2StreamHub – Bouquet Editor ───────────────────────────────────────── */

(function () {
  // ─── State ────────────────────────────────────────────────────────────────
  let currentBRef     = null;
  let currentFilePath = null;
  let currentItems    = [];
  let sortable        = null;
  let editorDirty     = false;
  let nextId          = 0;
  let saveDebounce    = null;
  let saveInProgress  = false;
  let savePending     = false;
  let searchAbort     = null;
  let searchTimer     = null;

  // ─── Elements ─────────────────────────────────────────────────────────────
  const overlay         = document.getElementById('editorOverlay');
  const bqSelect        = document.getElementById('editorBouquetSelect');
  const newBqBtn        = document.getElementById('editorNewBouquetBtn');
  const statusEl        = document.getElementById('editorStatus');
  const closeBtn        = document.getElementById('editorCloseBtn');
  const sortableEl      = document.getElementById('editorSortable');
  const emptyEl         = document.getElementById('editorEmpty');
  const nameInput       = document.getElementById('editorBouquetName');
  const markerBtn       = document.getElementById('editorAddMarkerBtn');
  const srcSelect       = document.getElementById('editorSourceSelect');
  const searchInput     = document.getElementById('editorSearch');
  const srcList         = document.getElementById('editorChannelList');
  const leftPanel       = document.getElementById('editorLeft');
  const rightPanel      = document.getElementById('editorRight');
  const piconFileInput  = document.getElementById('edPiconFileInput');

  // Currently pending picon upload target
  let piconUploadSRef = null;

  // Dialogs
  const markerDialog  = document.getElementById('edMarkerDialog');
  const markerInput   = document.getElementById('edMarkerInput');
  const markerConfirm = document.getElementById('edMarkerConfirm');
  const markerCancel  = document.getElementById('edMarkerCancel');
  const newBqDialog   = document.getElementById('edNewBqDialog');
  const newBqInput    = document.getElementById('edNewBqInput');
  const newBqConfirm  = document.getElementById('edNewBqConfirm');
  const newBqCancel   = document.getElementById('edNewBqCancel');

  // ─── Picon upload ─────────────────────────────────────────────────────────
  piconFileInput.addEventListener('change', async () => {
    const file = piconFileInput.files[0];
    const sRef = piconUploadSRef;
    piconFileInput.value = '';
    if (!file || !sRef) return;

    setStatus('Picon wird hochgeladen…');
    try {
      const base64 = await fileToBase64(file);
      const res = await fetch('/api/picon/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sRef, imageBase64: base64 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      // Bust browser cache and refresh all matching picon images on the page
      const cacheBust = `?t=${Date.now()}`;
      document.querySelectorAll(`.picon`)
        .forEach(img => {
          if (img.src.includes(encodeURIComponent(sRef))) {
            img.style.display = '';
            img.src = `/picon/${encodeURIComponent(sRef)}${cacheBust}`;
          }
        });

      setStatus(`Picon gespeichert ✓  (${data.piconDir})`, 5000);
    } catch (e) {
      setStatus(`Picon-Fehler: ${e.message}`);
    }
    piconUploadSRef = null;
  });

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ─── Open / Close ─────────────────────────────────────────────────────────
  function open() {
    populateSelects();
    activateTab('edit');
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function close() {
    if (editorDirty && !confirm('Ungespeicherte Änderungen verwerfen?')) return;
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
  }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')
        && markerDialog.style.display !== 'flex'
        && newBqDialog.style.display  !== 'flex') close();
  });
  window._editorOpen = open;

  // ─── Populate bouquet dropdowns ───────────────────────────────────────────
  function populateSelects() {
    const bouquets = window._app?.allBouquets || [];
    bqSelect.innerHTML  = '<option value="">Bouquet wählen…</option>';
    srcSelect.innerHTML = '<option value="">Alle Bouquets…</option>';
    bouquets.forEach(({ ref, name }) => {
      bqSelect.appendChild(new Option(name, ref));
      srcSelect.appendChild(new Option(name, ref));
    });
    if (currentBRef) bqSelect.value = currentBRef;
  }

  // ─── Auto-load on bouquet select ──────────────────────────────────────────
  bqSelect.addEventListener('change', async () => {
    const ref = bqSelect.value;
    if (!ref) return;
    if (editorDirty) {
      clearTimeout(saveDebounce);
      await doSave();
    }
    await loadBouquet(ref);
  });

  async function loadBouquet(bRef) {
    setStatus('Lädt…');
    try {
      const data = await window._app.apiFetch(`/api/bouquetedit?bRef=${encodeURIComponent(bRef)}`);
      currentBRef      = bRef;
      currentFilePath  = data.filePath || null;
      currentItems     = data.items || [];
      nextId = 1;
      currentItems.forEach(it => { it._id = nextId++; });
      // When file access is unavailable the server derives the name from the
      // filename (e.g. "news") — use the real display name from allBouquets instead.
      const realName = (window._app?.allBouquets || []).find(b => b.ref === bRef)?.name;
      nameInput.value = realName || data.name || '';
      editorDirty = false;
      renderSortable();
      const n    = currentItems.filter(i => i.type === 'service').length;
      const hint = data.noFileAccess ? ' ⚠ kein Dateizugriff' : '';
      setStatus(`${n} Kanäle${hint}`, 4000);
    } catch (e) {
      setStatus(`Fehler: ${e.message}`);
    }
  }

  // ─── Sortable list ────────────────────────────────────────────────────────
  function renderSortable() {
    if (sortable) { sortable.destroy(); sortable = null; }
    sortableEl.innerHTML = '';
    sortableEl.appendChild(emptyEl);
    emptyEl.style.display = currentItems.length ? 'none' : 'block';
    currentItems.forEach(item => sortableEl.appendChild(makeItem(item, item._id)));
    if (window.Sortable) {
      sortable = new window.Sortable(sortableEl, {
        animation: 150,
        handle: '.ed-handle',
        filter: '.list-placeholder',
        ghostClass: 'ed-item-ghost',
        chosenClass: 'ed-item-chosen',
        onEnd: () => { syncFromDOM(); markDirty(); },
      });
    }
  }

  function makeItem(item, domId) {
    const div   = document.createElement('div');
    div.className = 'ed-item' + (item.type === 'marker' ? ' ed-item-marker' : '');
    div.dataset.id = domId;
    const label = item.type === 'marker' ? (item.label || 'Marker') : (item.name || '');

    let iconHtml = '';
    if (item.type === 'marker') {
      iconHtml = '<span class="ed-marker-icon">📌</span>';
    } else if (item.sRef) {
      // Wrap picon in a clickable button for upload
      const piconHtml = window._app?.piconImg(item.sRef) || `<span class="ed-picon-placeholder"></span>`;
      iconHtml = `<button class="ed-picon-btn" title="Picon ändern" data-sref="${escHtml(item.sRef)}">${piconHtml}</button>`;
    }

    div.innerHTML = `
      <span class="ed-handle" title="Verschieben">⠿</span>
      ${iconHtml}
      <span class="ed-label">${escHtml(label)}</span>
      <button class="ed-del" title="Entfernen">✕</button>
    `;

    if (item.sRef) {
      div.querySelector('.ed-picon-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        piconUploadSRef = item.sRef;
        piconFileInput.click();
      });
    }

    div.querySelector('.ed-del').addEventListener('click', () => {
      currentItems = currentItems.filter(i => i._id !== domId);
      div.remove();
      emptyEl.style.display = currentItems.length ? 'none' : 'block';
      markDirty();
    });
    return div;
  }

  function syncFromDOM() {
    const ids = [...sortableEl.querySelectorAll('.ed-item')].map(el => +el.dataset.id);
    const map = new Map(currentItems.map(i => [i._id, i]));
    currentItems = ids.map(id => map.get(id)).filter(Boolean);
  }

  function markDirty() {
    editorDirty = true;
    scheduleSave();
  }

  nameInput.addEventListener('input', () => {
    markDirty();
    // Update the dropdown option text immediately so the user sees the new name
    if (currentBRef) {
      const opt = bqSelect.querySelector(`option[value="${currentBRef.replace(/"/g, '\\"')}"]`);
      if (opt) opt.textContent = nameInput.value.trim() || currentBRef;
    }
  });

  // ─── Auto-save ────────────────────────────────────────────────────────────
  function scheduleSave() {
    clearTimeout(saveDebounce);
    if (!currentBRef || !currentFilePath) return;
    setStatus('Wird gespeichert…');
    saveDebounce = setTimeout(doSave, 2000);
  }

  async function doSave() {
    if (!currentBRef || !currentFilePath) return;
    if (saveInProgress) { savePending = true; return; }
    saveInProgress = true;
    setStatus('Speichert…');
    try {
      const res = await fetch('/api/bouquetedit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: currentFilePath,
          name: nameInput.value.trim() || currentBRef,
          items: currentItems,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      editorDirty = false;
      setStatus('Gespeichert ✓', 4000);
      if (window._app?.channelCache) window._app.channelCache.delete(currentBRef);
    } catch (e) {
      setStatus(`Fehler: ${e.message}`);
    } finally {
      saveInProgress = false;
      if (savePending) { savePending = false; doSave(); }
    }
  }

  // ─── Marker dialog ────────────────────────────────────────────────────────
  markerBtn.addEventListener('click', () => {
    markerInput.value = '';
    markerDialog.style.display = 'flex';
    setTimeout(() => markerInput.focus(), 50);
  });
  markerCancel.addEventListener('click',  () => { markerDialog.style.display = 'none'; });
  markerConfirm.addEventListener('click', addMarker);
  markerInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  addMarker();
    if (e.key === 'Escape') markerDialog.style.display = 'none';
  });

  function addMarker() {
    const label = markerInput.value.trim() || 'Marker';
    markerDialog.style.display = 'none';
    const domId = nextId++;
    const item  = { type: 'marker', label, _id: domId };
    currentItems.push(item);
    sortableEl.appendChild(makeItem(item, domId));
    emptyEl.style.display = 'none';
    markDirty();
  }

  // ─── New bouquet dialog ───────────────────────────────────────────────────
  newBqBtn.addEventListener('click', () => {
    newBqInput.value = '';
    newBqDialog.style.display = 'flex';
    setTimeout(() => newBqInput.focus(), 50);
  });
  newBqCancel.addEventListener('click',  () => { newBqDialog.style.display = 'none'; });
  newBqConfirm.addEventListener('click', createBouquet);
  newBqInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  createBouquet();
    if (e.key === 'Escape') newBqDialog.style.display = 'none';
  });

  async function createBouquet() {
    const name = newBqInput.value.trim();
    if (!name) return;
    newBqDialog.style.display = 'none';
    setStatus('Erstelle Bouquet…');
    try {
      const res  = await fetch('/api/createbouquet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      // Add to allBouquets and refresh selects
      const allBqs = window._app?.allBouquets;
      if (allBqs) {
        allBqs.push({ ref: data.bRef, name: data.name });
        // Also sync the main sidebar bouquet select
        const mainSelect = window._app.bouquetSelect;
        if (mainSelect) {
          const opt = new Option(data.name, data.bRef);
          mainSelect.appendChild(opt);
        }
      }
      populateSelects();

      // Switch to and show the new bouquet
      bqSelect.value   = data.bRef;
      currentBRef      = data.bRef;
      currentFilePath  = data.filePath;
      currentItems     = [];
      nextId           = 1;
      nameInput.value  = data.name;
      editorDirty      = false;
      renderSortable();
      setStatus(`"${data.name}" erstellt ✓`, 4000);
    } catch (e) {
      setStatus(`Fehler: ${e.message}`);
    }
  }

  // ─── Source search (left panel) ───────────────────────────────────────────
  srcSelect.addEventListener('change', () => {
    searchInput.value = '';
    const ref = srcSelect.value;
    if (ref) loadSource(ref);
    else srcList.innerHTML = '<div class="list-placeholder">Bouquet wählen oder suchen</div>';
  });

  searchInput.addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 250);
  });

  async function loadSource(bRef) {
    srcList.innerHTML = '<div class="list-placeholder">Lädt…</div>';
    try {
      let svcs = window._app?.channelCache?.get(bRef);
      if (!svcs) {
        const d = await window._app.apiFetch(`/api/services?sRef=${encodeURIComponent(bRef)}`);
        svcs = d.services || [];
        window._app?.channelCache?.set(bRef, svcs);
      }
      renderSource(svcs.map(s => ({ svc: s, bouquetName: '' })), '');
    } catch (e) {
      srcList.innerHTML = `<div class="list-placeholder">Fehler: ${escHtml(e.message)}</div>`;
    }
  }

  async function runSearch(term) {
    const q         = term.trim().toLowerCase();
    const sourceRef = srcSelect.value;
    if (!q) {
      if (sourceRef) loadSource(sourceRef);
      else srcList.innerHTML = '<div class="list-placeholder">Bouquet wählen oder suchen</div>';
      return;
    }
    if (searchAbort) searchAbort.aborted = true;
    const abort = { aborted: false };
    searchAbort = abort;
    srcList.innerHTML = '<div class="list-placeholder">Suche…</div>';
    const results = [];
    const bouquets = window._app?.allBouquets || [];
    const list = sourceRef ? bouquets.filter(b => b.ref === sourceRef) : bouquets;
    for (const { ref, name: bouquetName } of list) {
      if (abort.aborted) return;
      let svcs = window._app?.channelCache?.get(ref);
      if (!svcs) {
        try {
          const d = await window._app.apiFetch(`/api/services?sRef=${encodeURIComponent(ref)}`);
          svcs = d.services || [];
          window._app?.channelCache?.set(ref, svcs);
        } catch { continue; }
      }
      if (abort.aborted) return;
      svcs.filter(s => s.servicename.toLowerCase().includes(q))
          .forEach(svc => results.push({ svc, bouquetName }));
      renderSource(results, q);
    }
  }

  function renderSource(results, q) {
    srcList.innerHTML = '';
    if (!results.length) {
      srcList.innerHTML = '<div class="list-placeholder">Keine Ergebnisse</div>';
      return;
    }
    let lastBq = null;
    results.forEach(({ svc, bouquetName }) => {
      if (bouquetName && bouquetName !== lastBq) {
        lastBq = bouquetName;
        const sep = document.createElement('div');
        sep.className   = 'search-bouquet-label';
        sep.textContent = bouquetName;
        srcList.appendChild(sep);
      }
      const already = currentItems.some(i => i.type === 'service' && i.sRef === svc.servicereference);
      const el = document.createElement('div');
      el.className = 'channel-item ed-src-item' + (already ? ' ed-src-added' : '');
      let namePart = escHtml(svc.servicename);
      if (q) {
        const lo = svc.servicename.toLowerCase(), ix = lo.indexOf(q);
        if (ix >= 0) namePart =
          escHtml(svc.servicename.slice(0, ix)) +
          `<mark>${escHtml(svc.servicename.slice(ix, ix + q.length))}</mark>` +
          escHtml(svc.servicename.slice(ix + q.length));
      }
      el.innerHTML = `
        ${window._app?.piconImg(svc.servicereference) || ''}
        <span class="channel-name" style="padding-left:0">${namePart}</span>
        <button class="ed-add-btn">${already ? '✓' : '+'}</button>
      `;
      const addFn = () => addChannel(svc, el);
      el.querySelector('.ed-add-btn').addEventListener('click', e => { e.stopPropagation(); addFn(); });
      el.addEventListener('click', addFn);
      srcList.appendChild(el);
    });
  }

  function addChannel(svc, srcEl) {
    if (currentItems.some(i => i.type === 'service' && i.sRef === svc.servicereference)) return;
    const domId = nextId++;
    const item  = { type: 'service', sRef: svc.servicereference, name: svc.servicename, _id: domId };
    currentItems.push(item);
    sortableEl.appendChild(makeItem(item, domId));
    emptyEl.style.display = 'none';
    markDirty();
    if (srcEl) {
      srcEl.classList.add('ed-src-added');
      const btn = srcEl.querySelector('.ed-add-btn');
      if (btn) btn.textContent = '✓';
    }
    if (window.innerWidth < 768) activateTab('edit');
  }

  // ─── Mobile tabs ──────────────────────────────────────────────────────────
  document.querySelectorAll('.editor-tab').forEach(tab => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });

  function activateTab(tab) {
    document.querySelectorAll('.editor-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === tab)
    );
    if (window.innerWidth < 768) {
      leftPanel.classList.toggle('ed-tab-hidden',  tab !== 'search');
      rightPanel.classList.toggle('ed-tab-hidden', tab !== 'edit');
    } else {
      leftPanel.classList.remove('ed-tab-hidden');
      rightPanel.classList.remove('ed-tab-hidden');
    }
  }

  // ─── Status helper ────────────────────────────────────────────────────────
  let statusTimer = null;
  function setStatus(msg, autoClear) {
    clearTimeout(statusTimer);
    statusEl.textContent = msg;
    if (autoClear) statusTimer = setTimeout(() => { if (!editorDirty) statusEl.textContent = ''; }, autoClear);
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
