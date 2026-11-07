# syntax=docker/dockerfile:1.7
# Multi-target build for the TypeScript services. Build context: repository root.
#   docker build --target backend   -t sportlight-backend .
#   docker build --target publisher -t sportlight-publisher .
#   docker build --target web       -t sportlight-web .

ARG NODE_VERSION=20.18

# ---------------------------------------------------------------- dependencies + build
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
COPY apps/publisher/package.json apps/publisher/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# Brand assets referenced by the web build.
COPY fonts ./fonts
COPY logos ./logos
RUN npm run build

# Production-only dependencies for the Node services.
FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
COPY apps/publisher/package.json apps/publisher/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund --workspace @sportlight/backend --workspace @sportlight/publisher --include-workspace-root=false

# ---------------------------------------------------------------- backend
FROM node:${NODE_VERSION}-alpine AS backend
ENV NODE_ENV=production PORT=4000 DATA_DIR=/data
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/backend/package.json ./apps/backend/package.json
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1
CMD ["node", "apps/backend/dist/index.js"]

# ---------------------------------------------------------------- mock publisher
FROM node:${NODE_VERSION}-alpine AS publisher
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/publisher/package.json ./apps/publisher/package.json
COPY --from=build /app/apps/publisher/dist ./apps/publisher/dist
USER node
CMD ["node", "apps/publisher/dist/index.js"]

# ---------------------------------------------------------------- web (static SPA + reverse proxy)
FROM nginx:1.27-alpine AS web
COPY docker/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
