<div align="center">

# 📺 E2StreamHub

**A slick, self-hosted web interface for your Enigma2 satellite receiver**

Stream live TV, browse the EPG, manage bouquets, and fully control your receiver — all from any browser on your network.

[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](#-quick-start)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](#%EF%B8%8F-tech-stack)
[![License](https://img.shields.io/badge/license-MIT-blue)](#)

<br/>

> Works with **Gigablue**, **Dreambox**, **VU+**, **Formuler** and any other Enigma2 receiver running [OpenWebif](https://github.com/E2OpenPlugins/e2openplugin-OpenWebif).

<br/>

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-%E2%98%95%20Support%20this%20project-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/gomble)

</div>

---

## ✨ Features

### 📡 Live Streaming
- **Fragmented MP4 via MSE** — primary mode, works on all modern browsers including iOS Safari 13+
- **HLS fallback** — for older iOS without Media Source Extensions
- **MPEG-TS fallback** — direct stream proxy as last resort
- **IPTV support** — plays embedded HTTP streams directly from type-5001/5002 service refs
- Automatic stream mode selection — no manual configuration needed
- H.264 + AAC re-encoding with `zerolatency` tuning for minimal latency

### 📋 Channel Browser
- Full bouquet & channel list pulled live from your receiver
- Channel picon (logo) display with auto-detection from the receiver's picon directory
- Current EPG title shown inline next to every channel
- Cross-bouquet search with progressive, live results as you type
- Click any channel to start streaming instantly

### 🎬 Recordings Playback
- Browse all recordings stored on the receiver's HDD
- Search recordings by name
- One-click playback via the same fMP4 pipeline
- Full description and metadata shown in the info panel

### 📅 EPG — Electronic Programme Guide
- **Full TV Guide timeline** with selectable 2 / 3 / 6 / 12 / 24-hour windows
- Scrollable horizontal timeline — browse past, present and future at once
- Navigate by bouquet; jump back to "Now" with one click
- Click any programme to open the **Detail modal**:
  - Full title, short & long description
  - Start/end times, duration, live progress bar
  - Tune directly to the channel from the modal
- Background EPG preload for instant availability

### ✏️ Bouquet Editor
- **Drag-and-drop channel reordering** powered by Sortable.js
- Add channels from any bouquet via a live search panel
- Remove channels, add section markers / dividers
- Rename bouquets and create new ones from scratch
- Changes are saved back to the receiver automatically (with 2-second debounce)
- Triggers an Enigma2 service list reload — no reboot required

### 🛰️ Receiver Control Panel

| Section | What you can do |
|---|---|
| **Info** | Model, image version, Enigma2 / kernel / WebIF versions, tuner names, network IPs, HDD usage |
| **Signal** | Live SNR bar (dB), AGC %, BER counter — refreshes every 5 s |
| **Power** | Standby, Reboot, Deep Standby, GUI Restart (all with confirmation) |
| **Volume** | +/− 5% buttons, click-to-set bar, mute toggle — live sync with receiver |
| **Sleep Timer** | Set duration & action (standby / deep standby), enable / disable |
| **Remote Control** | Full virtual remote — navigation, colour keys, media controls, teletext, EPG |
| **Send Message** | Push a text overlay to the receiver's screen with type and timeout |
| **Timers** | List, toggle, delete timers; bulk-clean expired recordings |
| **Settings** | Browse all Enigma2 settings as a searchable key-value list |

### ⚙️ App Settings
- Change login username and password
- **Two-Factor Authentication (TOTP)** — QR-code setup, works with Google Authenticator, Authy, etc.
- Receiver connection settings (host, ports, credentials, stream auth)
- ffmpeg tuning: transcode preset, probesize, analyzeduration
- HLS fallback tuning: segment duration, playlist depth
- All settings persist across container restarts via `data/config.json`

### 🔒 Security
- Session-based auth with 24-hour timeout
- TOTP 2FA with ±1 time-step tolerance
- HTTP Basic Auth support for the receiver's stream port
- Configurable session signing secret

### 🖥️ Quality of Life
- **Live Server Log** — real-time SSE stream, colour-coded by level, in a slide-out panel
- **Picture-in-Picture** — draggable & resizable floating player, stays visible across all views
- **Web-based Setup Wizard** — guided first-launch configuration, no manual config files needed
- **Response compression** — gzip on all API responses for fast loading on slow networks
- **API caching** — bouquets (2 min), services (2 min), EPG (30 s) to avoid hammering the receiver

---

## 🚀 Quick Start

### 1. Clone

```bash
git clone https://github.com/gomble/E2StreamHub.git
cd E2StreamHub
```

### 2. Start

```bash
docker compose up -d
```

### 3. Open

```
http://YOUR-SERVER-IP:2000
```

On first launch, the **setup wizard** walks you through connecting to your receiver. Nothing else needed.

---

## 🐳 Docker Compose

```yaml
services:
  e2streamhub:
    build: .
    container_name: e2streamhub
    ports:
      - "2000:2000"
    environment: {}            # Leave empty → setup wizard on first launch
    volumes:
      - e2streamhub-data:/app/data     # Persistent config
    tmpfs:
      - /app/hls-sessions:size=128m    # RAM disk for HLS sessions
    restart: unless-stopped

volumes:
  e2streamhub-data:
```

> **Network tip:** If the container can't reach the receiver, add `network_mode: host` (Linux only).

---

## 🔧 Configuration

All settings are available through the in-app **Settings panel** (⚙ button). Environment variables always override saved settings.

| Variable | Default | Description |
|---|---|---|
| `ENIGMA2_HOST` | `192.168.1.100` | Receiver IP or hostname |
| `ENIGMA2_PORT` | `80` | OpenWebif HTTP port |
| `ENIGMA2_STREAM_PORT` | `8001` | Enigma2 stream source port |
| `ENIGMA2_SSH_PORT` | `22` | SSH port for bouquet/picon file access |
| `ENIGMA2_USER` | *(empty)* | OpenWebif username |
| `ENIGMA2_PASSWORD` | *(empty)* | OpenWebif password |
| `ENIGMA2_STREAM_AUTH` | `false` | Send HTTP Basic Auth on stream requests |
| `APP_USERNAME` | `admin` | E2StreamHub login username |
| `APP_PASSWORD` | `admin` | E2StreamHub login password — **change this!** |
| `SESSION_SECRET` | *(auto-generated)* | Session signing key — **change this!** |
| `FFMPEG_FORCE_VIDEO_TRANSCODE` | `false` | Always re-encode video (for HEVC/H.265 sources) |
| `FFMPEG_TRANSCODE_PRESET` | `veryfast` | H.264 preset: `ultrafast` → `medium` |
| `FFMPEG_PROBESIZE` | `10000000` | ffmpeg input probe buffer size |
| `FFMPEG_ANALYZEDURATION` | `10000000` | ffmpeg stream analysis depth |
| `HLS_SEGMENT_SECONDS` | `2` | HLS segment duration (iOS fallback) |
| `HLS_LIST_SIZE` | `4` | HLS playlist buffer depth |
| `PORT` | `2000` | HTTP port the server listens on |

---

## 🏗️ How It Works

```
Browser
  │
  │  GET /stream-fmp4?sRef=...
  │
  ▼
E2StreamHub (Node.js / Express)
  │
  ├─ 1. extractIptvUrl()   → IPTV channel? use embedded HTTP URL directly
  │
  ├─ 2. resolveSptsUrl()   → ask receiver /web/stream.m3u for SPTS URL
  │
  └─ 3. buildSourceUrl()   → fallback to raw MPTS on the stream port
              │
              ▼
          ffmpeg
            reads MPEG-TS → H.264 + AAC → Fragmented MP4 → pipe:1
                                                               │
Browser ◄──────────────── chunked HTTP ◄───────────────────────┘
  MediaSource API
  SourceBuffer.appendBuffer()
  videoEl.play()
```

**Streaming priority:**
1. **fMP4 via MSE** — lowest latency, works everywhere including iOS 13+
2. **HLS** — segment-based fallback for old iOS
3. **MPEG-TS** — raw stream proxy, last resort

**Bouquet/picon file access fallback chain:**
1. OpenWebif HTTP file API
2. SSH / SFTP
3. Enigma2 `/etc/enigma2/settings` lookup

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 20, Express 4, axios, ssh2, compression |
| Transcoding | ffmpeg — H.264 + AAC → fMP4 |
| Frontend | Vanilla HTML5 / CSS3 / JavaScript (no frameworks) |
| Video Playback | MSE (native), mpegts.js, hls.js |
| Drag & Drop | Sortable.js |
| Container | Docker — node:20-alpine + ffmpeg |

---

## 📋 Requirements

- **Docker** and **Docker Compose**
- An Enigma2 receiver with **OpenWebif** installed and reachable on the network
- Port `2000` accessible on the host (configurable)

---

## ☕ Support the project

If E2StreamHub is useful to you, a coffee keeps development going!

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-%E2%98%95-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/gomble)

---

<div align="center">
<sub>Made with ❤️ for the Enigma2 community</sub>
</div>
