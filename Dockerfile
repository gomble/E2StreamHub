FROM node:20-alpine

# ffmpeg is used server-side to extract a single program from MPTS streams
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json .
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/

# Download mpegts.js to serve locally (avoids CDN tracking prevention in browsers)
RUN wget -q -O src/public/js/mpegts.js \
    https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js
RUN wget -q -O src/public/js/hls.min.js \
    https://cdn.jsdelivr.net/npm/hls.js@1.5.18/dist/hls.min.js

EXPOSE 3000

CMD ["node", "src/server.js"]
