# E2StreamHub

Web-basiertes Streaming-Interface für Enigma2-Empfänger (Gigablue, Dreambox, VU+ etc.) mit OpenWebif.

## Features

- **Live-Streaming** direkt im Browser (MPEG-TS via mpegts.js)
- **Bouquet & Kanal-Browser** (Sat + IPTV)
- **EPG-Infopanel** mit aktuellem und folgenden Programmen
- **EPG-Timeline** (TV-Guide) mit 3-Stunden-Ansicht
- **Authentifizierung** (Web-Interface Login)
- **Docker-ready**

## Schnellstart mit Docker

### 1. Repository klonen

```bash
git clone https://github.com/DEIN-USERNAME/E2StreamHub.git
cd E2StreamHub
```

### 2. `docker-compose.yml` anpassen

```yaml
environment:
  - ENIGMA2_HOST=192.168.1.XXX   # IP deines Empfängers
  - ENIGMA2_PORT=80               # OpenWebif Port (Standard: 80)
  - ENIGMA2_STREAM_PORT=8001      # Streaming Port (Standard: 8001)
  - ENIGMA2_USER=                 # Empfänger-Benutzername (leer = kein Auth)
  - ENIGMA2_PASSWORD=             # Empfänger-Passwort
  - APP_USERNAME=admin            # Login für das Web-Interface
  - APP_PASSWORD=MeinSicheresPasswort
  - SESSION_SECRET=ZufaelligerGeheimString32Zeichen
```

### 3. Container starten

```bash
docker compose up -d
```

### 4. Browser öffnen

```
http://DEIN-SERVER-IP:3000
```

---

## Netzwerk-Hinweis

Der Docker-Container muss deinen Enigma2-Empfänger erreichen können. Wenn beides im selben LAN ist, funktioniert es mit dem Standard `bridge` Netzwerkmodus und der korrekten IP in `ENIGMA2_HOST`.

Falls Verbindungsprobleme auftreten, kann `network_mode: host` in der `docker-compose.yml` helfen (Linux only):

```yaml
network_mode: host
```

---

## Umgebungsvariablen

| Variable              | Standard              | Beschreibung                                |
|-----------------------|-----------------------|---------------------------------------------|
| `ENIGMA2_HOST`        | `192.168.1.100`       | IP-Adresse / Hostname des Empfängers        |
| `ENIGMA2_PORT`        | `80`                  | OpenWebif HTTP-Port                         |
| `ENIGMA2_STREAM_PORT` | `8001`                | Enigma2 Streaming-Port                      |
| `ENIGMA2_USER`        | *(leer)*              | HTTP-Auth Benutzername (falls aktiviert)    |
| `ENIGMA2_PASSWORD`    | *(leer)*              | HTTP-Auth Passwort                          |
| `APP_USERNAME`        | `admin`               | Benutzername für das Web-Interface          |
| `APP_PASSWORD`        | `admin`               | Passwort für das Web-Interface (**ändern!**)|
| `SESSION_SECRET`      | *(Standardwert)*      | Zufälliger String für Sessions (**ändern!**)|
| `PORT`                | `3000`                | HTTP-Port des Containers                    |

---

## Lokale Entwicklung (ohne Docker)

```bash
npm install
# .env.example kopieren und anpassen
cp .env.example .env
# .env bearbeiten (ENIGMA2_HOST etc.)
npm run dev
```

---

## Technologie

- **Backend**: Node.js + Express (MPEG-TS Stream-Proxy, OpenWebif-API-Proxy)
- **Frontend**: Vanilla HTML/CSS/JS
- **Player**: [mpegts.js](https://github.com/xqq/mpegts.js)
- **Container**: Docker (Node 20 Alpine)

## OpenWebif API

Der Backend-Proxy nutzt folgende OpenWebif-Endpunkte:

| Endpunkt                         | Verwendung              |
|----------------------------------|-------------------------|
| `/api/bouquets`                  | Bouquet-Liste           |
| `/api/getservices?sRef=...`      | Kanäle im Bouquet       |
| `/api/epgservice?sRef=...`       | EPG eines Kanals        |
| `/api/epgbouquet?bRef=...`       | EPG-Bulk für TV-Guide   |
| `http://HOST:8001/<sRef>`        | Live-Stream             |
