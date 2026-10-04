# syntax=docker/dockerfile:1

# CryptoTrace AI — single-image build for the API and the built SPA.
#
# The image is Debian-based (node:22-slim) rather than Alpine on purpose:
# argon2 is a native addon, and the musl/Alpine split forces a source build
# that needs a full toolchain. The glibc prebuilds install cleanly, so the
# runtime image needs no compilers at all.
#
# The monorepo layout is preserved in the final image because the server
# resolves the SPA by path: index.ts looks for `../../web/dist` relative to its
# own compiled file, so `server/dist` and `web/dist` must stay siblings.


###############################################################################
# 1. Full dependency tree (dev deps needed to compile the server and SPA)
###############################################################################
FROM node:22-slim AS deps

WORKDIR /app

# Manifests only. Copying just these first means the dependency layer is
# rebuilt only when a lockfile or manifest actually changes, not on every
# source edit.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
# The indexer is a workspace too, and `npm run build` compiles all three. Without
# this manifest npm ci never installs its dependencies, so the build stage fails
# with "Cannot find module 'axios'".
COPY indexer/package.json ./indexer/

# Toolchain for the case where a prebuild for this platform is unavailable.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm ci


###############################################################################
# 2. Compile the server and build the SPA
###############################################################################
FROM deps AS build

WORKDIR /app
COPY . .

# The server build also copies src/db/schema.sql into dist/db/, which is where
# migrate() reads it from at runtime.
RUN npm run build


###############################################################################
# 3. Production dependency tree only
###############################################################################
# Built separately so the ~1 GB of dev tooling (typescript, vite, eslint) never
# reaches the runtime image. The toolchain stays in this stage and is simply not
# copied forward.
FROM node:22-slim AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Workspace-scoped: the SPA is already compiled into static assets, so only the
# server's runtime dependencies are actually needed. The web workspace's React
# dependencies come along for the ride; they cost a couple of megabytes and are
# never imported at runtime.
RUN npm ci --omit=dev


###############################################################################
# 4. Runtime
###############################################################################
FROM node:22-slim AS runtime

LABEL org.opencontainers.image.title="CryptoTrace AI" \
      org.opencontainers.image.description="Blockchain forensics workspace (API + SPA)" \
      org.opencontainers.image.licenses="Proprietary"

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

WORKDIR /app

# server/src/paths.ts creates DATA_DIR at import time. It defaults to
# <repo>/data, which the non-root `node` user cannot create because /app is
# root-owned, so point it at a directory that is created here and handed over.
# Mount a volume over it to keep uploads and the database across rebuilds.
RUN mkdir -p /app/data && chown node:node /app/data

# npm workspaces hoist every dependency to the root node_modules, so there is no
# per-workspace directory to copy.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/server/package.json ./server/package.json

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# The node image ships a non-root `node` user (uid 1000). Running as it means a
# container escape does not start as root on the host.
USER node

EXPOSE 8080

# Uses Node's built-in fetch, so the image needs no curl/wget just to probe
# itself. /api/health reports "degraded" (HTTP 503) when the database is
# unreachable, which is exactly the condition this should fail on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>r.json()).then(j=>process.exit(j.status==='ok'?0:1)).catch(()=>process.exit(1))"

# Equivalent to `npm start`, but without the npm wrapper in the signal path so
# SIGTERM reaches Node directly and the graceful shutdown handler runs.
CMD ["node", "server/dist/index.js"]
