# @orbit/desktop

The Orbit desktop app: an Electron shell around the Orbit web client, with a first-run
setup window, a local Docker stack controller, and Hermes wiring.

The renderer is **the server's own web build**. There is no desktop-only UI beyond
`setup.html`.

## Develop

```bash
pnpm --filter @orbit/desktop run build   # esbuild -> dist/ (main, preload, setup)
pnpm --filter @orbit/desktop run dev     # build, then `electron .`
pnpm --filter @orbit/desktop run test    # node:test via tsx
pnpm --filter @orbit/desktop run typecheck
```

`dev` needs a server. Either run the repo's dev server (`pnpm dev`, port 8787) and pick
"This computer" with Docker up, or point the app straight at a URL:

```bash
ORBIT_WEB_URL=http://localhost:5173 pnpm --filter @orbit/desktop run dev
```

`ORBIT_WEB_URL` overrides the saved setup for one launch. `--server=<url>` does the same.

## Layout

```
src/main.ts                 app lifecycle, IPC, startup decision
src/setup-config.ts         ORBIT_WEB_URL > saved setup > setup window; partition hashing
src/server-url.ts           normalizeServerUrl (shared with the setup renderer)
src/setup-store.ts          userData/setup.json, written 0600
src/app-window.ts           the main window: partition, headers, external-link policy
src/app-menu.ts             application menu
src/auto-update.ts          electron-updater + the update bar
src/badge.ts                unread badge from /api/bots + /api/events
src/session-permissions.ts  microphone only
src/setup.html/.css/.ts     the first-run window (540x420, two screens)
src/docker-cli.ts           docker binary lookup, failure classification, runDocker
src/local-stack.ts          idle -> … -> ready state machine
src/local-stack-networking.ts  .orbit-web-url / .orbit-stack-token
src/env-file.ts             .env read/patch + secret generation
src/loopback-port.ts        free loopback port allocation
src/hermes-setup.ts         detect / install / wire Hermes (all I/O injected)
src/hermes-setup-window.ts  install ordering + progress streaming
src/preload.cjs             contextBridge: window.orbitDesktop
src/shared/api.ts           desktop types + IPC channel names
```

## Packaging

`electron-builder.yml` reads three paths from outside this package:

| Path | Becomes | Produced by |
| --- | --- | --- |
| `../web/dist` | `Contents/Resources/web` | `pnpm --filter @orbit/web build` |
| `../../infra/compose/docker-compose.images.yml` | `Contents/Resources/stack/docker-compose.yml` | infra |
| `../../infra/compose/.env.images.example` | `Contents/Resources/stack/.env.example` | infra |

`pnpm --filter @orbit/desktop run check-resources` fails with a readable list when one is
missing; `pack` and `release` run it for you.

At runtime the stack controller resolves those two locations this way:

* packaged: `path.join(process.resourcesPath, 'stack')`
* dev: `path.resolve(app.getAppPath(), '..', '..', 'infra', 'compose')`

so `pnpm dev` in a checkout reads the compose file straight out of `infra/compose`.

## Smoke test

```bash
ORBIT_SMOKE=1 pnpm --filter @orbit/desktop exec electron .
```

Loads `dist/setup.html` in a hidden window, prints `typeof window.orbitDesktop`, the
bridge's keys, the resolved stack resource dir, and exits 0/1. Add
`ORBIT_SMOKE_SCREENSHOT=/tmp/shot.png` to also write the three setup-window states
(server choice, Hermes step, existing instance) as PNGs.

## Updates

`electron-updater` against GitHub Releases (`raybello/orbit`). Checks on launch and every
four hours, downloads automatically, then shows a non-modal bar. Disabled unless
`app.isPackaged`. Release with a `v*` tag: `.github/workflows/desktop-release.yml`.
