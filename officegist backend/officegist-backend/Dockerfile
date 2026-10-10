FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# Dependencies first so Docker caches this layer. Uses the lockfile if you have committed one.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .
USER node
EXPOSE 4000
CMD ["node", "src/server.js"]
