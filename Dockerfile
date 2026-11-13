# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=26.12.1
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.npm npm install --global "$(node -p 'require("./package.json").packageManager')"
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
COPY scripts/build.mjs scripts/build-admin.mjs ./scripts/
RUN --mount=type=cache,target=/pnpm/store pnpm build && pnpm prune --prod --config.store-dir=/pnpm/store

FROM node:${NODE_VERSION}-alpine AS runtime
ARG VCS_REF=unknown
ARG SOURCE_URL=https://github.com/vizmoe/miniflux-ai
LABEL org.opencontainers.image.title="miniflux-ai" \
      org.opencontainers.image.source=${SOURCE_URL} \
      org.opencontainers.image.revision=${VCS_REF} \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache libstdc++ && mkdir -p /app/data /app/config && chown node:node /app/data /app/config
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node package.json LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node licenses ./licenses
USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "dist/healthcheck.js", "--config", "/app/config/config.yaml"]
CMD ["node", "--single-threaded-gc", "dist/main.js", "--config", "/app/config/config.yaml"]
