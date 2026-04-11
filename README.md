# E2StreamHub

Web-based streaming interface for Enigma2 receivers (Gigablue, Dreambox, VU+ etc.) using OpenWebif.

## Features

- **Live streaming** directly in the browser (MPEG-TS via mpegts.js)
- **Bouquet & channel browser** (Satellite + IPTV)
- **EPG info panel** with current and upcoming programmes
- **EPG timeline** (TV guide) with 3-hour scrollable view
- **Session authentication** for the web interface
- **Docker-ready**

## Quick Start with Docker

### 1. Clone the repository

```bash
git clone https://github.com/YOUR-USERNAME/E2StreamHub.git
cd E2StreamHub
```

### 2. Edit `docker-compose.yml`

```yaml
environment:
  - ENIGMA2_HOST=192.168.1.XXX   # IP address of your receiver
  - ENIGMA2_PORT=80               # OpenWebif port (default: 80)
  - ENIGMA2_STREAM_PORT=8001      # Streaming port (default: 8001)
  - ENIGMA2_USER=                 # Receiver username (leave empty if no auth)
  - ENIGMA2_PASSWORD=             # Receiver password
  - APP_USERNAME=admin            # Web interface login username
  - APP_PASSWORD=MySecurePassword
  - SESSION_SECRET=RandomStringAtLeast32Chars
```

### 3. Start the container

```bash
docker compose up -d
```

### 4. Open in browser

```
http://YOUR-SERVER-IP:3000
```

---

## Network Note

The Docker container must be able to reach your Enigma2 receiver. If both are on the same LAN, the default `bridge` network mode works fine with the correct IP in `ENIGMA2_HOST`.

If you experience connection issues, `network_mode: host` in `docker-compose.yml` may help (Linux only):

```yaml
network_mode: host
```

---

## Environment Variables

| Variable              | Default               | Description                                         |
|-----------------------|-----------------------|-----------------------------------------------------|
| `ENIGMA2_HOST`        | `192.168.1.100`       | IP address / hostname of the receiver               |
| `ENIGMA2_PORT`        | `80`                  | OpenWebif HTTP port                                 |
| `ENIGMA2_STREAM_PORT` | `8001`                | Enigma2 streaming port                              |
| `ENIGMA2_USER`        | *(empty)*             | HTTP auth username (if enabled on the receiver)     |
| `ENIGMA2_PASSWORD`    | *(empty)*             | HTTP auth password                                  |
| `APP_USERNAME`        | `admin`               | Web interface login username                        |
| `APP_PASSWORD`        | `admin`               | Web interface login password (**change this!**)     |
| `SESSION_SECRET`      | *(default)*           | Random string for session signing (**change this!**)|
| `PORT`                | `3000`                | HTTP port exposed by the container                  |

---

## Local Development (without Docker)

```bash
npm install
cp .env.example .env
# Edit .env and set ENIGMA2_HOST etc.
npm run dev
```

---

## Tech Stack

- **Backend**: Node.js + Express (MPEG-TS stream proxy, OpenWebif API proxy)
- **Frontend**: Vanilla HTML / CSS / JS
- **Player**: [mpegts.js](https://github.com/xqq/mpegts.js)
- **Container**: Docker (Node 20 Alpine)

## OpenWebif API Endpoints Used

| Endpoint                         | Purpose                    |
|----------------------------------|----------------------------|
| `/api/bouquets`                  | Bouquet list               |
| `/api/getservices?sRef=...`      | Channels in a bouquet      |
| `/api/epgservice?sRef=...`       | EPG for a single channel   |
| `/api/epgbouquet?bRef=...`       | Bulk EPG for TV guide      |
| `http://HOST:8001/<sRef>`        | Live stream                |
