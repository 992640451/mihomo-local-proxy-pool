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

COPY scripts/build-metadata.mjs scripts/write-build-info.mjs scripts/release-utils.mjs ./scripts/
ARG PPM_BUILD_REVISION
ARG PPM_BUILD_TIME
ARG TARGETPLATFORM
RUN PPM_BUILD_REVISION="$PPM_BUILD_REVISION" PPM_BUILD_TIME="$PPM_BUILD_TIME" node scripts/write-build-info.mjs --target "${TARGETPLATFORM:-linux}"

FROM node:26.8.1-bookworm-slim AS runtime

ARG PPM_BUILD_REVISION
ARG PPM_BUILD_TIME
ARG PPM_BUILD_VERSION
LABEL org.opencontainers.image.source="https://github.com/992640451/mihomo-local-proxy-pool" \
    org.opencontainers.image.revision=$PPM_BUILD_REVISION \
    org.opencontainers.image.created=$PPM_BUILD_TIME \
    org.opencontainers.image.version=$PPM_BUILD_VERSION \
    org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    APP_HOST=0.0.0.0 \
    PORT=4180

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

RUN mkdir -p /data /mihomo && chown node:node /data /mihomo

COPY server ./server
COPY shared ./shared
COPY release ./release
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/build-info.json ./build-info.json

USER node
EXPOSE 4180

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4180/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server/index.mjs"]
