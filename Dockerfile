FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json .
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/

EXPOSE 3000

CMD ["node", "src/server.js"]
