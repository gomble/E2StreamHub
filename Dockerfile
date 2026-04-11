FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json .
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/

# Download mpegts.js to serve locally (avoids CDN tracking prevention in browsers)
RUN wget -q -O src/public/js/mpegts.js \
    https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js

EXPOSE 3000

CMD ["node", "src/server.js"]
