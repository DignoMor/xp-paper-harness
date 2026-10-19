# syntax=docker/dockerfile:1

# ---- Build stage: install every dependency and compile the application ----
FROM node:22.20.0-bookworm-slim AS build

# Build tooling for any native addons. Runtime never receives these.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install the full dependency tree first so the layer caches across source edits.
COPY package.json package-lock.json ./
RUN npm ci

# Bring in the source, TypeScript config, and browser bundling script. The
# .dockerignore keeps node_modules, dist, .git, .env, and data out of the context.
COPY . .

# `npm run build` compiles with tsc and copies browser assets into dist/web/static.
RUN npm run build

# ---- Runtime stage: production dependencies and compiled output only ----
FROM node:22.20.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only; the lockfile makes this reproducible.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && rm -rf /root/.npm

# Compiled server plus the browser assets emitted into dist/web/static.
COPY --from=build /app/dist ./dist

# Mount point for the external data root. A bind mount overrides ownership, but
# a named volume inherits this and stays writable by the unprivileged user.
RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 8787

CMD ["node", "dist/main.js"]
