# Orbit server image (@orbit/server).
#
# Build it from the REPOSITORY ROOT, never from apps/server: the build needs the pnpm workspace
# (pnpm-workspace.yaml, pnpm-lock.yaml, packages/*) that lives one level above this Dockerfile.
#
#   docker build -f apps/server/Dockerfile -t orbit/app:dev .
#
# It builds the API *and* the web client, because index.ts serves apps/web/dist when it is there.
# The same image also runs the sandbox supervisor: `docker run ... orbit/app:dev node dist/supervisor.js`.

# ---------------------------------------------------------------- build
FROM node:22-alpine AS builder

# corepack reads "packageManager": "pnpm@12.8.1" from package.json, so the image uses exactly the
# pnpm that wrote pnpm-lock.yaml (--frozen-lockfile would fail on a different major).
# python3/make/g++ are only for ssh2's optional crypto binding (dockerode depends on ssh2), which
# compiles if it can and is skipped otherwise; without them the failure is loud.
RUN corepack enable \
 && apk add --no-cache python3 make g++
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
WORKDIR /app

# Manifests first: the install layer is reused as long as no package.json or the lockfile changes.
# Every importer pnpm-workspace.yaml globs has to exist here, or the workspace is half-resolved.
# tsconfig.base.json is what packages/* extend; .npmrc sets the hoisting the lockfile was built with.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/logger/package.json packages/logger/
COPY packages/ui-tokens/package.json packages/ui-tokens/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# Only these two projects (and their workspace dependencies); apps/desktop and apps/mobile are not
# in the image and are not installed.
RUN pnpm install --frozen-lockfile --store-dir=/pnpm/store \
      --filter @orbit/server... --filter @orbit/web...

COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web

# The three packages are built artefacts (their exports point at dist/), so they go first.
# Build order matters: the server imports @orbit/contracts and @orbit/logger from dist/.
RUN pnpm --filter "./packages/*" run build \
 && pnpm --filter @orbit/server run build \
 && pnpm --filter @orbit/web run build

# pnpm deploy produces a self-contained tree: dist/, the built workspace packages and only the
# production dependencies (no typescript, no tsx, no source). This is what the runtime stage copies.
RUN pnpm --filter @orbit/server deploy --prod --store-dir=/pnpm/store /out \
 && rm -rf /out/src /out/tsconfig.json

# ---------------------------------------------------------------- runtime
FROM node:22-alpine AS runtime

# A non-root user, and /data owned by it so a named volume created from this image is writable:
# SQLite needs to create orbit.db, its WAL files and the engines/computers directories there.
RUN addgroup -S orbit \
 && adduser -S -G orbit -h /app orbit \
 && mkdir -p /data /app/apps/web/src/avatar \
 && chown orbit:orbit /data /app

WORKDIR /app

# The server resolves paths relative to its own file, so the repo layout has to be kept:
#   dist/index.js  -> ../../web/dist            = /app/apps/web/dist          (the web client)
#   dist/desk.ts   -> ../../web/src/avatar/...  = /app/apps/web/src/avatar/... (the bots' avatar art)
#   dist/docker/image.js -> ../../docker/computer = /app/apps/server/docker/computer (bot sandbox image)
COPY --from=builder --chown=orbit:orbit /out/ /app/apps/server/
COPY --from=builder --chown=orbit:orbit /app/apps/web/dist /app/apps/web/dist
COPY --from=builder --chown=orbit:orbit /app/apps/web/src/avatar/shapes.gen.ts /app/apps/web/src/avatar/shapes.gen.ts

ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/orbit.db \
    ENGINES_DIR=/data/engines \
    COMPUTER_HOME_DIR=/data/computers \
    LOG_LEVEL=info

WORKDIR /app/apps/server
USER orbit
EXPOSE 8787

# No curl or wget in alpine beyond busybox, and busybox wget is not in every base — node is.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
