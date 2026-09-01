FROM node:26.8.1-bookworm-slim AS builder

ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src
COPY shared ./shared
RUN npm run build

FROM node:26.8.1-bookworm-slim AS runtime

ENV NODE_ENV=production \
    APP_HOST=0.0.0.0 \
    PORT=4180

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

RUN mkdir -p /data /mihomo && chown node:node /data /mihomo

COPY server ./server
COPY shared ./shared
COPY --from=builder /app/dist ./dist

USER node
EXPOSE 4180

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4180/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server/index.mjs"]
