# Used by Render (Runtime: Docker, Root Directory: ai-service).
# poppler-utils provides `pdftoppm`, needed only for scanned-paper PDF OCR.
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "src/server.js"]
