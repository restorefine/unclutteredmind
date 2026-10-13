# Uncluttered Mind — production image (no npm dependencies to install)
FROM node:24-alpine

RUN apk add --no-cache tzdata

ENV NODE_ENV=production \
    TZ=Europe/London \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "server.js"]
