# Multi-stage build for optArb apps (M11).
# Default CMD runs apps/trader; override via docker-compose or `docker run`.

FROM node:22-slim AS build

# Enable pnpm via corepack (packageManager field pins pnpm@11.5.2).
RUN corepack enable && corepack prepare pnpm@11.5.2 --activate

WORKDIR /app

# Copy workspace manifests first for better layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

# Full install is required because tsx is a devDependency and we run TypeScript
# directly in production (build is typecheck only).
RUN pnpm install --frozen-lockfile

# Typecheck the whole workspace; this is the only build step.
RUN pnpm build

# --- Runtime stage ---
FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@11.5.2 --activate

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/tsconfig.base.json ./
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages

# Health endpoint port (configurable via HEALTH_PORT env).
EXPOSE 8080
ENV HEALTH_PORT=8080
ENV HEALTH_ENABLED=true

CMD ["node", "--import", "tsx", "apps/trader/src/main.ts"]
