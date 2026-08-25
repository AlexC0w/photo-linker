FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000

COPY package*.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build && npm prune --omit=dev

VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server/index.js"]
