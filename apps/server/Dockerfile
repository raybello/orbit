# Orbit server image (@orbit/server).
#
# Build it from the REPOSITORY ROOT, never from apps/server: the build needs the pnpm workspace
# (pnpm-workspace.yaml, pnpm-lock.yaml, packages/*) that lives one level above this Dockerfile.
#
#   docker build -f apps/server/Dockerfile -t orbit/app:dev .
#
# It builds the API *and* the web client, because index.ts serves apps/web/dist when it is there.
# The same image also runs the sandbox supervisor: `docker run ... orbit/app:dev node dist/supervisor.js`.
#
# It also ships the Hermes CLI, because the desktop app runs this server inside this image and every
# managed Bot needs `hermes` to start its own gateway. Previously the image had no Hermes at all, so
# every bot creation ended in `spawn hermes ENOENT` and a bot that could not answer.

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

# ---------------------------------------------------------------- hermes
#
# Hermes is a Python CLI distributed as a git checkout driven by uv: its setup.py deliberately
# refuses to build a wheel ("distributed via the shell installer, Docker image, or Nix"), and the
# PyPI package stopped at 0.19.0 while releases moved on. So the supported headless install is
# exactly what the official installer does -- shallow clone of a release tag, then `uv sync`
# against the checkout's own uv.lock -- with the tag and uv pinned here instead of floating.
#
# It stays on the same alpine base as the runtime so the venv's interpreter (the image's own
# python3, currently 3.14, which is the version Hermes targets) and its musl wheels match the
# runtime exactly. The base's python drifting past 3.14 would fail the `hermes --version` check
# below loudly rather than ship a broken engine.
FROM node:22-alpine AS hermes

# The release to ship. Bump this and the image gets a newer engine; the uv.lock in that tag pins
# every Python dependency, so the build is reproducible.
ARG HERMES_VERSION=v0.23.1
# The uv that resolves that lock (the version the upstream image builds with).
ARG UV_VERSION=0.13.8

RUN apk add --no-cache python3 ca-certificates curl git bash

# --no-modify-path: PATH is set in the runtime stage, not by a shell profile this image never reads.
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" \
      | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh \
 && uv --version

# --depth 1 at a tag: no history, and a moving branch cannot change what gets installed.
RUN git clone --depth 1 --branch "${HERMES_VERSION}" \
      https://github.com/NousResearch/hermes-agent.git /opt/hermes

WORKDIR /opt/hermes

# --frozen installs exactly uv.lock (no re-resolve at build time) and --no-dev keeps pytest/ruff out.
# The extras are the ones a managed Bot needs to be an Orbit engine rather than a bare REPL:
#   anthropic  the Claude-subscription sign-in path imports the SDK
#   mcp        the client for the `hq` MCP server Orbit injects into each Bot's config
# aiohttp is the gateway's api_server adapter -- without it `hermes gateway run` starts, says
# "No adapter available for api_server" and never binds the port Orbit talks to. It is a pinned
# dependency of several platform extras but no extra of its own, so it is installed by pin.
# The browser/computer-use extras cannot be installed here: playwright publishes no musllinux
# wheels, and those tools run inside a Bot's own computer container (see COMPUTER_IMAGE).
RUN uv venv --python /usr/bin/python3 /opt/hermes/.venv \
 && uv sync --frozen --no-dev --extra anthropic --extra mcp \
 && uv pip install --python /opt/hermes/.venv/bin/python "aiohttp==3.14.5"

# Bury the checkout identity in install-stamp.json before the history goes: `hermes --version` and
# the gateway's /health read it, and without it they report "vunknown".
RUN /opt/hermes/.venv/bin/python -c \
      "from pathlib import Path; from hermes_cli.source_stamp import write_source_stamp; \
       assert write_source_stamp(Path('/opt/hermes')), 'no git identity to stamp'"

# The tree is the running code, not a checkout: drop what only a developer needs. Keeps ~300MB of
# tests, website, desktop apps and history out of the shipped image.
RUN rm -rf /opt/hermes/.git /opt/hermes/tests /opt/hermes/tests-js /opt/hermes/website \
           /opt/hermes/apps /opt/hermes/contributors /opt/hermes/docs /opt/hermes/evals \
           /opt/hermes/.github /opt/hermes/nix \
 && printf 'docker\n' > /opt/hermes/.install_method

# The CLI must work for the non-root runtime user, and the install tree is immutable for it: state
# belongs in HERMES_HOME (/data/hermes, on the volume), never here.
RUN chmod -R a+rX,go-w /opt/hermes \
 && /opt/hermes/.venv/bin/hermes --version

# ---------------------------------------------------------------- runtime
FROM node:22-alpine AS runtime

# python3 runs the Hermes venv (its interpreter is this image's /usr/bin/python3.14); bash and git
# are what Hermes' own tools shell out to. A non-root user, and /data owned by it so a named volume
# created from this image is writable: SQLite needs orbit.db, and the engines/Hermes homes live
# there too.
RUN apk add --no-cache python3 bash git ca-certificates \
 && addgroup -S orbit \
 && adduser -S -G orbit -h /app orbit \
 && mkdir -p /data/hermes /app/apps/web/src/avatar \
 && chown orbit:orbit /data /data/hermes /app

WORKDIR /app

# The server resolves paths relative to its own file, so the repo layout has to be kept:
#   dist/index.js  -> ../../web/dist            = /app/apps/web/dist          (the web client)
#   dist/desk.ts   -> ../../web/src/avatar/...  = /app/apps/web/src/avatar/... (the bots' avatar art)
#   dist/docker/image.js -> ../../docker/computer = /app/apps/server/docker/computer (bot sandbox image)
COPY --from=builder --chown=orbit:orbit /out/ /app/apps/server/
COPY --from=builder --chown=orbit:orbit /app/apps/web/dist /app/apps/web/dist
COPY --from=builder --chown=orbit:orbit /app/apps/web/src/avatar/shapes.gen.ts /app/apps/web/src/avatar/shapes.gen.ts

# The engine. Owned by root and read-only for orbit: nothing at runtime should rewrite the code that
# runs the agents. HERMES_HOME_PRIMARY is the primary agent's home *inside this container* -- the
# real one runs on the host and is reached over HERMES_URL -- so it only needs to be writable for
# the config a managed bot seeds from.
COPY --from=hermes /opt/hermes /opt/hermes

ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/orbit.db \
    ENGINES_DIR=/data/engines \
    COMPUTER_HOME_DIR=/data/computers \
    HERMES_HOME_PRIMARY=/data/hermes \
    HERMES_BIN=/opt/hermes/.venv/bin/hermes \
    PATH=/opt/hermes/.venv/bin:$PATH \
    LOG_LEVEL=info

WORKDIR /app/apps/server
USER orbit
EXPOSE 8787

# No curl or wget in alpine beyond busybox, and busybox wget is not in every base — node is.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
