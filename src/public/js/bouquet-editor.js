/* ─── E2StreamHub – Bouquet Editor ───────────────────────────────────────── */

(function () {
  // ─── State ────────────────────────────────────────────────────────────────
  let currentBRef     = null;
  let currentFilePath = null;   // received from GET /api/bouquetedit
  let currentItems    = [];     // { type, sRef, name, label, id }
  let sortable        = null;
  let editorDirty     = false;
  let searchAbort     = null;
  let searchTimer     = null;
  let nextId          = 0;      // integer counter for client-side items

  // ─── Elements ─────────────────────────────────────────────────────────────
  const overlay      = document.getElementById('editorOverlay');
  const bqSelect     = document.getElementById('editorBouquetSelect');
  const loadBtn      = document.getElementById('editorLoadBtn');
  const statusEl     = document.getElementById('editorStatus');
  const saveBtn      = document.getElementById('editorSaveBtn');
  const closeBtn     = document.getElementById('editorCloseBtn');
  const sortableEl   = document.getElementById('editorSortable');
  const emptyEl      = document.getElementById('editorEmpty');
  const nameInput    = document.getElementById('editorBouquetName');
  const markerBtn    = document.getElementById('editorAddMarkerBtn');
  const srcSelect    = document.getElementById('editorSourceSelect');
  const searchInput  = document.getElementById('editorSearch');
  const srcList      = document.getElementById('editorChannelList');
  const leftPanel    = document.getElementById('editorLeft');
  const rightPanel   = document.getElementById('editorRight');

  // ─── Open / Close ─────────────────────────────────────────────────────────
  function open() {
    populateSelects();
    activateTab('edit');  // ensure correct initial tab on mobile
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
    if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });

  // Exposed for app.js nav wiring
  window._editorOpen = open;

  // ─── Populate bouquet dropdowns ───────────────────────────────────────────
  function populateSelects() {
    const bouquets = (window._app && window._app.allBouquets) || [];
    bqSelect.innerHTML = '<option value="">Select bouquet…</option>';
    srcSelect.innerHTML = '<option value="">All bouquets…</option>';
    bouquets.forEach(({ ref, name }) => {
      const o1 = new Option(name, ref);
      const o2 = new Option(name, ref);
      bqSelect.appendChild(o1);
      srcSelect.appendChild(o2);
    });
    if (currentBRef) bqSelect.value = currentBRef;
  }

  // ─── Load ─────────────────────────────────────────────────────────────────
  loadBtn.addEventListener('click', async () => {
    const ref = bqSelect.value;
    if (!ref) return;
    if (editorDirty && !confirm('Ungespeicherte Änderungen verwerfen?')) return;
    await loadBouquet(ref);
  });

  async function loadBouquet(bRef) {
    setStatus('Lädt…');
    saveBtn.disabled = true;
    try {
      const data = await window._app.apiFetch(`/api/bouquetedit?bRef=${encodeURIComponent(bRef)}`);
      currentBRef      = bRef;
      currentFilePath  = data.filePath || null;
      currentItems     = data.items || [];
      // Assign integer ids to all loaded items so DOM lookups work
      nextId = 1;
      currentItems.forEach(it => { it._id = nextId++; });
      nameInput.value = data.name || '';
      editorDirty = false;
      renderSortable();
      const n = currentItems.filter(i => i.type === 'service').length;
      setStatus(`Geladen · ${n} Kanäle`);
      saveBtn.disabled = false;
    } catch (e) {
      setStatus(`Fehler: ${e.message}`);
    }
  }

  // ─── Render sortable list ─────────────────────────────────────────────────
  function renderSortable() {
    if (sortable) { sortable.destroy(); sortable = null; }
    sortableEl.innerHTML = '';
    sortableEl.appendChild(emptyEl);             // keep emptyEl in DOM
    emptyEl.style.display = currentItems.length ? 'none' : 'block';
    currentItems.forEach(item => sortableEl.appendChild(makeItem(item, item._id)));

    if (window.Sortable) {
      sortable = new window.Sortable(sortableEl, {
        animation: 150,
        handle: '.ed-handle',
        filter: '.list-placeholder',
        ghostClass: 'ed-item-ghost',
        chosenClass: 'ed-item-chosen',
        onEnd: syncFromDOM,
      });
    }
  }

  function makeItem(item, domId) {
    const div = document.createElement('div');
    div.className = 'ed-item' + (item.type === 'marker' ? ' ed-item-marker' : '');
    div.dataset.id = domId;

    const label = item.type === 'marker' ? (item.label || 'Marker') : (item.name || '');
    const icon  = item.type === 'marker' ? '<span class="ed-marker-icon">📌</span>' : '';

    div.innerHTML = `
      <span class="ed-handle" title="Verschieben">⠿</span>
      ${icon}
      <span class="ed-label">${escHtml(label)}</span>
      <button class="ed-del" title="Entfernen">✕</button>
    `;
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
    markDirty();
  }

  function markDirty() {
    editorDirty = true;
    saveBtn.disabled = !currentBRef;
  }

  // ─── Add Marker ───────────────────────────────────────────────────────────
  markerBtn.addEventListener('click', () => {
    const label = prompt('Markername:');
    if (label === null) return;
    const domId = nextId++;
    const item = { type: 'marker', label: label.trim() || 'Marker', _id: domId };
    currentItems.push(item);
    sortableEl.appendChild(makeItem(item, domId));
    emptyEl.style.display = 'none';
    markDirty();
  });

  nameInput.addEventListener('input', markDirty);

  // ─── Save ─────────────────────────────────────────────────────────────────
  saveBtn.addEventListener('click', async () => {
    if (!currentBRef) return;
    saveBtn.disabled = true;
    setStatus('Speichert…');
    try {
      const res = await fetch('/api/bouquetedit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: currentFilePath,
          name: nameInput.value.trim(),
          items: currentItems,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      editorDirty = false;
      setStatus('Gespeichert ✓', 3000);
      // Invalidate sidebar cache so next visit reloads
      if (window._app?.channelCache) window._app.channelCache.delete(currentBRef);
    } catch (e) {
      setStatus(`Fehler: ${e.message}`);
    } finally {
      saveBtn.disabled = false;
    }
  });

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
    const q = term.trim().toLowerCase();
    const sourceRef = srcSelect.value;

    if (!q) {
      if (sourceRef) { loadSource(sourceRef); }
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
        sep.className = 'search-bouquet-label';
        sep.textContent = bouquetName;
        srcList.appendChild(sep);
      }

      const already = currentItems.some(i => i.type === 'service' && i.sRef === svc.servicereference);
      const el = document.createElement('div');
      el.className = 'channel-item ed-src-item' + (already ? ' ed-src-added' : '');

      let namePart = escHtml(svc.servicename);
      if (q) {
        const lo = svc.servicename.toLowerCase();
        const ix = lo.indexOf(q);
        if (ix >= 0) {
          namePart = escHtml(svc.servicename.slice(0, ix))
            + `<mark>${escHtml(svc.servicename.slice(ix, ix + q.length))}</mark>`
            + escHtml(svc.servicename.slice(ix + q.length));
        }
      }

      el.innerHTML = `
        <span class="channel-name" style="padding-left:0">${namePart}</span>
        <button class="ed-add-btn" title="Hinzufügen">${already ? '✓' : '+'}</button>
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
    const item = { type: 'service', sRef: svc.servicereference, name: svc.servicename, _id: domId };
    currentItems.push(item);
    sortableEl.appendChild(makeItem(item, domId));
    emptyEl.style.display = 'none';
    markDirty();

    if (srcEl) {
      srcEl.classList.add('ed-src-added');
      const btn = srcEl.querySelector('.ed-add-btn');
      if (btn) btn.textContent = '✓';
    }

    // On mobile, switch to edit tab after adding
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
    leftPanel.classList.toggle('ed-tab-hidden',  tab !== 'search');
    rightPanel.classList.toggle('ed-tab-hidden', tab !== 'edit');
  }

  // ─── Status helper ────────────────────────────────────────────────────────
  let statusTimer = null;
  function setStatus(msg, autoClear) {
    clearTimeout(statusTimer);
    statusEl.textContent = msg;
    if (autoClear) statusTimer = setTimeout(() => { if (!editorDirty) statusEl.textContent = ''; }, autoClear);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
