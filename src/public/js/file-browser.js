/* ─── E2StreamHub – SFTP File Browser ────────────────────────────────────── */

(function () {
  const overlay    = document.getElementById('fileBrowserOverlay');
  const closeBtn   = document.getElementById('fbCloseBtn');
  const splitBtn   = document.getElementById('fbSplitBtn');
  const pathInput  = document.getElementById('fbPathInput');
  const fileList   = document.getElementById('fbFileList');
  const breadcrumb = document.getElementById('fbBreadcrumb');
  const editorModal = document.getElementById('fbEditorModal');
  const editorTitle = document.getElementById('fbEditorTitle');
  const editorArea  = document.getElementById('fbEditorArea');
  const editorSave  = document.getElementById('fbEditorSave');
  const editorClose = document.getElementById('fbEditorClose');
  const ctxMenu     = document.getElementById('fbContextMenu');

  let currentPath = '/';
  let selectedItems = new Set();
  let ctxTarget = null;

  const quickLinks = [
    { name: 'Root /', path: '/' },
    { name: 'Enigma2 Config', path: '/etc/enigma2' },
    { name: 'Plugins', path: '/usr/lib/enigma2/python/Plugins' },
    { name: 'Skins', path: '/usr/share/enigma2' },
    { name: 'Recordings', path: '/media/hdd/movie' },
    { name: 'Picons', path: '/usr/share/enigma2/picon' },
    { name: 'EPG Data', path: '/etc/enigma2/epg.dat' },
    { name: 'Scripts', path: '/usr/script' },
    { name: 'Tmp', path: '/tmp' },
    { name: 'Media', path: '/media' },
    { name: 'Softcams', path: '/usr/keys' },
    { name: 'Boot', path: '/boot' }
  ];

  function open() {
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    if (fileList.children.length <= 1) navigate(currentPath);
  }

  function close() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.classList.remove('split-right');
    const termOv = document.getElementById('terminalOverlay');
    if (termOv) termOv.classList.remove('split-left');
  }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      if (editorModal.classList.contains('open')) { closeEditor(); return; }
      if (ctxMenu.style.display === 'block') { hideCtx(); return; }
      close();
    }
  });
  window._fileBrowserOpen = open;
  window._fbRefresh = () => navigate(currentPath);

  // Quick links
  const qlContainer = document.getElementById('fbQuickLinks');
  quickLinks.forEach(ql => {
    const btn = document.createElement('button');
    btn.className = 'fb-ql-btn';
    btn.textContent = ql.name;
    btn.title = ql.path;
    btn.addEventListener('click', () => navigate(ql.path));
    qlContainer.appendChild(btn);
  });

  // Breadcrumb
  function updateBreadcrumb(p) {
    breadcrumb.innerHTML = '';
    const parts = p.split('/').filter(Boolean);
    const crumb = (label, path) => {
      const a = document.createElement('span');
      a.className = 'fb-crumb';
      a.textContent = label;
      a.addEventListener('click', () => navigate(path));
      return a;
    };
    breadcrumb.appendChild(crumb('/', '/'));
    let acc = '';
    parts.forEach((part, i) => {
      acc += '/' + part;
      const sep = document.createElement('span');
      sep.className = 'fb-crumb-sep';
      sep.textContent = '/';
      breadcrumb.appendChild(sep);
      breadcrumb.appendChild(crumb(part, acc));
    });
  }

  // Navigate
  async function navigate(dir) {
    try {
      const res = await fetch(`/api/files/ls?path=${encodeURIComponent(dir)}`);
      const data = await res.json();
      if (data.error) { alert(data.error); return; }
      currentPath = dir;
      pathInput.value = dir;
      updateBreadcrumb(dir);
      renderFiles(data.entries || []);
      selectedItems.clear();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  pathInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') navigate(pathInput.value.trim() || '/');
  });

  function renderFiles(files) {
    fileList.innerHTML = '';

    if (currentPath !== '/') {
      const parentPath = currentPath.replace(/\/[^/]+\/?$/, '') || '/';
      const row = mkRow({ name: '..', isDir: true }, parentPath);
      fileList.appendChild(row);
    }

    files.forEach(f => {
      fileList.appendChild(mkRow(f));
    });
  }

  function mkRow(f, overridePath) {
    const row = document.createElement('div');
    row.className = 'fb-row' + (f.isDir ? ' fb-dir' : '');
    row.dataset.name = f.name;
    row.dataset.path = overridePath || (currentPath === '/' ? '/' + f.name : currentPath + '/' + f.name);
    row.dataset.isDir = f.isDir ? '1' : '0';

    const icon = document.createElement('span');
    icon.className = 'fb-icon';
    icon.textContent = f.isDir ? '📁' : fileIcon(f.name);

    const name = document.createElement('span');
    name.className = 'fb-name';
    name.textContent = f.name;

    const size = document.createElement('span');
    size.className = 'fb-size';
    size.textContent = f.isDir ? '' : fmtSize(f.size || 0);

    const date = document.createElement('span');
    date.className = 'fb-date';
    date.textContent = f.mtime ? new Date(f.mtime * 1000).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';

    const perms = document.createElement('span');
    perms.className = 'fb-perms';
    perms.textContent = f.mode || '';

    row.append(icon, name, size, date, perms);

    row.addEventListener('dblclick', () => {
      if (f.isDir || f.name === '..') {
        navigate(row.dataset.path);
      } else {
        openFile(row.dataset.path, f.name);
      }
    });

    row.addEventListener('click', e => {
      if (f.name === '..') return;
      if (e.ctrlKey || e.metaKey) {
        row.classList.toggle('selected');
        if (row.classList.contains('selected')) selectedItems.add(row.dataset.path);
        else selectedItems.delete(row.dataset.path);
      } else {
        fileList.querySelectorAll('.fb-row.selected').forEach(r => r.classList.remove('selected'));
        selectedItems.clear();
        row.classList.add('selected');
        selectedItems.add(row.dataset.path);
      }
    });

    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      ctxTarget = { path: row.dataset.path, name: f.name, isDir: f.isDir };
      showCtx(e.clientX, e.clientY);
    });

    return row;
  }

  // Context menu
  function showCtx(x, y) {
    ctxMenu.style.display = 'block';
    ctxMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
    ctxMenu.style.top = Math.min(y, window.innerHeight - 300) + 'px';
  }

  function hideCtx() { ctxMenu.style.display = 'none'; }
  document.addEventListener('click', () => hideCtx());

  document.getElementById('fbCtxOpen')?.addEventListener('click', () => {
    if (!ctxTarget) return;
    if (ctxTarget.isDir) navigate(ctxTarget.path);
    else openFile(ctxTarget.path, ctxTarget.name);
  });

  document.getElementById('fbCtxRename')?.addEventListener('click', async () => {
    if (!ctxTarget) return;
    const newName = prompt('Neuer Name:', ctxTarget.name);
    if (!newName || newName === ctxTarget.name) return;
    const parentDir = ctxTarget.path.replace(/\/[^/]+$/, '') || '/';
    const newPath = parentDir + '/' + newName;
    await apiPost('/api/files/rename', { from: ctxTarget.path, to: newPath });
    navigate(currentPath);
  });

  document.getElementById('fbCtxCopy')?.addEventListener('click', async () => {
    if (!ctxTarget) return;
    const dest = prompt('Ziel-Pfad:', ctxTarget.path + '_copy');
    if (!dest) return;
    await apiPost('/api/files/copy', { from: ctxTarget.path, to: dest });
    navigate(currentPath);
  });

  document.getElementById('fbCtxMove')?.addEventListener('click', async () => {
    if (!ctxTarget) return;
    const dest = prompt('Verschieben nach:', ctxTarget.path);
    if (!dest || dest === ctxTarget.path) return;
    await apiPost('/api/files/rename', { from: ctxTarget.path, to: dest });
    navigate(currentPath);
  });

  document.getElementById('fbCtxDelete')?.addEventListener('click', async () => {
    if (!ctxTarget) return;
    if (!confirm(`"${ctxTarget.name}" wirklich löschen?`)) return;
    await apiPost('/api/files/delete', { path: ctxTarget.path });
    navigate(currentPath);
  });

  document.getElementById('fbCtxDownload')?.addEventListener('click', () => {
    if (!ctxTarget || ctxTarget.isDir) return;
    window.open(`/api/files/download?path=${encodeURIComponent(ctxTarget.path)}`, '_blank');
  });

  // Toolbar buttons
  document.getElementById('fbNewFolder')?.addEventListener('click', async () => {
    const name = prompt('Neuer Ordner:');
    if (!name) return;
    const p = currentPath === '/' ? '/' + name : currentPath + '/' + name;
    await apiPost('/api/files/mkdir', { path: p });
    navigate(currentPath);
  });

  document.getElementById('fbNewFile')?.addEventListener('click', () => {
    const name = prompt('Neue Datei:');
    if (!name) return;
    const p = currentPath === '/' ? '/' + name : currentPath + '/' + name;
    openEditor(p, name, '', true);
  });

  document.getElementById('fbRefresh')?.addEventListener('click', () => navigate(currentPath));

  document.getElementById('fbDeleteSelected')?.addEventListener('click', async () => {
    if (selectedItems.size === 0) return;
    if (!confirm(`${selectedItems.size} Element(e) löschen?`)) return;
    for (const p of selectedItems) {
      await apiPost('/api/files/delete', { path: p });
    }
    selectedItems.clear();
    navigate(currentPath);
  });

  // Text editor
  async function openFile(filePath, fileName) {
    const ext = fileName.split('.').pop().toLowerCase();
    const textExts = ['txt','conf','cfg','xml','py','sh','log','json','ini','yml','yaml','html','css','js','ts','service','timer','list','ipk','rule','pls','m3u','csv'];
    if (!textExts.includes(ext) && !fileName.startsWith('.')) {
      window.open(`/api/files/download?path=${encodeURIComponent(filePath)}`, '_blank');
      return;
    }
    try {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (data.error) { alert(data.error); return; }
      openEditor(filePath, fileName, data.content || '');
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  function openEditor(filePath, fileName, content, isNew) {
    editorTitle.textContent = isNew ? 'Neue Datei: ' + fileName : fileName;
    editorArea.value = content;
    editorModal.classList.add('open');
    editorModal.dataset.path = filePath;
    editorModal.dataset.isNew = isNew ? '1' : '0';
    editorArea.focus();
  }

  function closeEditor() {
    editorModal.classList.remove('open');
  }

  editorClose.addEventListener('click', closeEditor);

  editorSave.addEventListener('click', async () => {
    const filePath = editorModal.dataset.path;
    const content = editorArea.value;
    try {
      const res = await apiPost('/api/files/write', { path: filePath, content });
      if (res.error) { alert(res.error); return; }
      closeEditor();
      navigate(currentPath);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });

  // Split screen
  splitBtn?.addEventListener('click', () => {
    if (window._terminalOpen) {
      const termOv = document.getElementById('terminalOverlay');
      termOv.classList.add('open', 'split-left');
      termOv.setAttribute('aria-hidden', 'false');
      overlay.classList.add('split-right');
      if (window._terminalIsOpen && !window._terminalIsOpen()) {
        window._terminalOpen();
      }
    }
  });

  // Helpers
  async function apiPost(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.json();
  }

  function fmtSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
  }

  function fileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const icons = {
      py: '🐍', sh: '📜', conf: '⚙', cfg: '⚙', xml: '📄', json: '📋',
      log: '📃', txt: '📝', jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼',
      mp4: '🎬', ts: '🎬', mkv: '🎬', avi: '🎬', mp3: '🎵', wav: '🎵',
      zip: '📦', gz: '📦', tar: '📦', ipk: '📦', deb: '📦',
      html: '🌐', css: '🎨', js: '📜', service: '🔧', timer: '⏱'
    };
    return icons[ext] || '📄';
  }
})();
