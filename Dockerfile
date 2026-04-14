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

EXPOSE 3000

CMD ["node", "src/server.js"]
