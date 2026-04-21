/* ─── E2StreamHub – SSH Terminal + Command Panel ─────────────────────────── */

(function () {
  const overlay  = document.getElementById('terminalOverlay');
  const closeBtn = document.getElementById('terminalCloseBtn');
  const splitBtn = document.getElementById('terminalSplitBtn');
  const termBox  = document.getElementById('termContainer');
  const cmdBtns  = document.querySelectorAll('.cmd-btn');

  let term = null;
  let fitAddon = null;
  let ws = null;
  let connected = false;

  function open() {
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    if (!term) initTerminal();
    if (!connected) connect();
    setTimeout(() => { if (fitAddon) fitAddon.fit(); term?.focus(); }, 120);
  }

  function close() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
  }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });
  window._terminalOpen = open;
  window._terminalClose = close;

  function initTerminal() {
    term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      theme: {
        background: '#0d0d0d',
        foreground: '#e0e0e0',
        cursor: '#e50914',
        selectionBackground: 'rgba(229,9,20,.3)',
        black: '#0d0d0d',
        red: '#e50914',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e0e0e0'
      },
      allowProposedApi: true
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(termBox);
    fitAddon.fit();

    term.onData(data => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data }));
      }
    });

    const ro = new ResizeObserver(() => {
      if (fitAddon && overlay.classList.contains('open')) {
        fitAddon.fit();
        if (ws && ws.readyState === WebSocket.OPEN && term) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      }
    });
    ro.observe(termBox);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/ssh`);

    ws.onopen = () => {
      connected = true;
      term?.writeln('\x1b[32mConnected to receiver.\x1b[0m\r');
      if (fitAddon) fitAddon.fit();
      if (term) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    ws.onmessage = evt => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'data') {
          term?.write(msg.data);
        } else if (msg.type === 'error') {
          term?.writeln(`\r\n\x1b[31mError: ${msg.message}\x1b[0m`);
        }
      } catch {
        term?.write(evt.data);
      }
    };

    ws.onclose = () => {
      connected = false;
      term?.writeln('\r\n\x1b[33mDisconnected. Click "Reconnect" or reopen terminal.\x1b[0m');
    };

    ws.onerror = () => {
      connected = false;
    };
  }

  document.getElementById('termReconnectBtn')?.addEventListener('click', () => {
    if (ws) { ws.close(); ws = null; }
    connected = false;
    term?.clear();
    term?.writeln('\x1b[33mReconnecting…\x1b[0m');
    connect();
  });

  // Command panel buttons
  cmdBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      if (!cmd) return;

      if (btn.dataset.mode === 'exec') {
        fetch('/api/ssh/exec', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd })
        })
        .then(r => r.json())
        .then(data => {
          term?.writeln(`\r\n\x1b[36m$ ${cmd}\x1b[0m`);
          if (data.error) {
            term?.writeln(`\x1b[31m${data.error}\x1b[0m`);
          } else if (data.output) {
            data.output.split('\n').forEach(line => term?.writeln(line));
          }
          if (!data.ok) {
            term?.writeln('\x1b[31mFailed.\x1b[0m');
          }
        })
        .catch(err => term?.writeln(`\r\n\x1b[31m${err.message}\x1b[0m`));
      } else {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data: cmd + '\n' }));
        }
      }
    });
  });

  // Split screen toggle
  splitBtn?.addEventListener('click', () => {
    if (window._fileBrowserOpen) {
      const termOv = document.getElementById('terminalOverlay');
      const fbOv = document.getElementById('fileBrowserOverlay');
      termOv.classList.add('split-left');
      fbOv.classList.add('open', 'split-right');
      fbOv.setAttribute('aria-hidden', 'false');
      if (fitAddon) setTimeout(() => fitAddon.fit(), 150);
      if (window._fbRefresh) window._fbRefresh();
    }
  });

  window._terminalIsOpen = () => overlay.classList.contains('open');
})();
