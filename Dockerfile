FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# restic for optional off-site backups; ca-certificates for cloud backend TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends restic ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# App dependencies (only our own; the proprietary `ob` client is installed at
# runtime by docker-entrypoint.sh, never baked into this image).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV CONFIG_DIR=/config \
    VAULT_DIR=/vault \
    BACKUP_DIR=/backup \
    MIRROR_DIR=/mirror \
    WEBUI_PORT=8080 \
    BACKUP=false \
    MIRROR=false \
    TZ=Europe/Zurich

VOLUME ["/config", "/vault"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEBUI_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
