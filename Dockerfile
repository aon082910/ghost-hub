# Ghost-Hub: self-hosted digital-footprint cleaner.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
# Don't send Next.js's anonymous build telemetry: this is a privacy tool.
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ARG VERSION=dev
LABEL org.opencontainers.image.title="Ghost-Hub" \
      org.opencontainers.image.description="Self-hosted digital-footprint cleaner" \
      org.opencontainers.image.source="https://github.com/aon082910/ghost-hub" \
      org.opencontainers.image.url="https://github.com/aon082910/ghost-hub" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
# SQL migrations, applied on startup by src/instrumentation.ts
COPY --from=build --chown=app:app /app/drizzle ./drizzle
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
