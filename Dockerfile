FROM node:20-alpine

# ffmpeg is used server-side to extract a single program from MPTS streams
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json .
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/

# Download client-side player libraries to serve locally
RUN wget -q --tries=3 --timeout=30 -O src/public/js/mpegts.js \
    https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js && \
    echo "mpegts.js downloaded: $(wc -c < src/public/js/mpegts.js) bytes"
RUN wget -q --tries=3 --timeout=30 -O src/public/js/hls.min.js \
    https://cdn.jsdelivr.net/npm/hls.js@1.5.18/dist/hls.min.js && \
    echo "hls.min.js downloaded: $(wc -c < src/public/js/hls.min.js) bytes"
RUN wget -q --tries=3 --timeout=30 -O src/public/js/sortable.min.js \
    https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js && \
    echo "sortable.min.js downloaded: $(wc -c < src/public/js/sortable.min.js) bytes"
RUN wget -q --tries=3 --timeout=30 -O src/public/js/xterm.js \
    https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js && \
    echo "xterm.js downloaded: $(wc -c < src/public/js/xterm.js) bytes"
RUN wget -q --tries=3 --timeout=30 -O src/public/css/xterm.css \
    https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css && \
    echo "xterm.css downloaded: $(wc -c < src/public/css/xterm.css) bytes"
RUN wget -q --tries=3 --timeout=30 -O src/public/js/xterm-addon-fit.js \
    https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js && \
    echo "xterm-addon-fit.js downloaded: $(wc -c < src/public/js/xterm-addon-fit.js) bytes"

EXPOSE 3000

CMD ["node", "src/server.js"]
