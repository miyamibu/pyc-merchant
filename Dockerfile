ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE} AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN groupadd --system appuser \
  && useradd --system --gid appuser --create-home --home-dir /home/appuser appuser \
  && mkdir -p /app/runtime/data /app/runtime/backups /app/runtime/logs \
  && chown -R appuser:appuser /app /home/appuser

USER appuser

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.APP_PORT || process.env.PORT || 4173) + '/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.mjs"]
