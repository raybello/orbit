Markdown · orbit-implementation-plan.md

# Orbit Desktop & Mobile Implementation Plan

> **Scope**: Transform the existing Orbit monorepo (Node/Hono server + React web) into a full-stack product — Electron desktop app (macOS, Windows, Linux) with Docker-managed local stack + Hermes installer, and an Expo/React Native mobile app (iOS + Android) that pairs to any Orbit server. Restructure the codebase into a pnpm monorepo along the way.

---

## Reading this plan

Each **Part** is an independent parallel track once its stated prerequisites are met. Parts 2, 3, and 4 may all start as soon as Part 1 finishes; Parts 2 and 3 never touch the same files. Each Part is broken into **Phases** that must run in order within that track.

---

## Part 1 — Monorepo Migration

**Prerequisites**: none (this is the foundation everything else builds on)\
**Output**: `main` branch restructured; all existing `npm run dev` and `npm run build` commands still work

### Phase 1-A: Workspace scaffold

1. Replace root `package.json` with a pnpm workspace root:
   - `name: "orbit-workspace"`, `private: true`, `engines: { node: ">=22" }`
   - `workspaces: ["apps/*", "packages/*"]`
   - Root scripts: `dev`, `build`, `typecheck` via `turbo run`
2. Add `pnpm-workspace.yaml`:

   ```yaml
   packages:
     - "apps/*"
     - "packages/*"
   ```
3. Add `turbo.json` at root (pipeline: `build` depends on upstream builds, `dev` is concurrent, `typecheck` is concurrent)
4. Add `.npmrc`: `shamefully-hoist=false`, `auto-install-peers=true`

### Phase 1-B: Move existing apps

1. Move `server/` → `apps/server/` (update `package.json` name to `@orbit/server`)
2. Move `web/` → `apps/web/` (update `package.json` name to `@orbit/web`)
3. Update all relative `../` import paths that cross the boundary (there should be none; they communicate over HTTP)
4. Update root `scripts/` paths that reference `server/` or `web/`
5. Verify `pnpm run dev` from root starts both apps

### Phase 1-C: Extract shared packages

Create the following packages (each is a minimal `package.json` + `src/index.ts`):

**`packages/contracts`** (`@orbit/contracts`)\
Extract from `apps/server/src/types.ts` and `apps/server/src/routes.ts`:

- All shared TypeScript types: `Bot`, `BotRow`, `ComputerState`, `BotScreen`, `EngineKind`, `EngineProvider`, `EngineInfo`, `AvatarColor`, `AvatarShape`, `Toolkit`, `RoutineRow`, `TaskRow`, `MessageRow`
- API response shapes used by the web client
- SSE event discriminated union type (`EventPayload`)
- Export all from `src/index.ts`; tsconfig extends `tsconfig.base.json` from root

**`packages/ui-tokens`** (`@orbit/ui-tokens`)

- CSS custom properties file (`tokens.css`) defining: color semantic tokens (bg, fg, card, muted, border, accent, destructive, success), spacing scale, font families, border radii
- A TypeScript source (`src/tokens.ts`) exporting the token names as typed constants (so both web and mobile can reference them)
- Initially: copy the existing color variables from `apps/web/src/styles/`

**`packages/logger`** (`@orbit/logger`)

- Thin wrapper around `console` with `[orbit]` prefix and log level filtering via `LOG_LEVEL` env var
- Used by server and desktop main process

After extraction: update `apps/server` and `apps/web` to import from `@orbit/contracts` and `@orbit/ui-tokens` instead of local paths.

---

## Part 2 — Electron Desktop App

**Prerequisites**: Part 1 complete\
**Works on**: `apps/desktop/` only — no overlap with Part 3 (mobile)\
**Output**: Signed, distributable Electron app for macOS (dmg+zip), Windows (NSIS), Linux (AppImage); published to GitHub Releases; ships with Docker Compose local stack + Hermes setup

### Phase 2-A: Electron scaffold

**Directory**: `apps/desktop/`

**`package.json`** (`@orbit/desktop`):

```json
{
  "name": "@orbit/desktop",
  "productName": "Orbit",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/main.js",
  "scripts": {
    "dev": "pnpm build && electron .",
    "build": "node scripts/build.mjs",
    "pack": "pnpm --filter @orbit/web build && pnpm build && electron-builder",
    "release": "pnpm --filter @orbit/web build && pnpm build && electron-builder --publish never"
  }
}
```

Key dependencies: `electron@36`, `electron-builder@26`, `electron-updater@6`, `esbuild@0.24`\
Dev dependencies: `@orbit/contracts`, `@orbit/logger`, `typescript@5`

**`scripts/build.mjs`**: ESBuild pipeline compiling `src/main.ts`, `src/preload.cjs` (CommonJS), `src/setup.ts` (the first-run renderer entry point) to `dist/`

### Phase 2-B: Main process

**`src/main.ts`** — entry point wired by `electron-builder`

Responsibilities:

1. Read saved setup from `userData/setup.json` (via `src/setup-store.ts`)
2. Decide startup target: `{ kind: "setup" }` on first launch, `{ kind: "app", url }` when a setup is saved
3. If `kind === "setup"`: show the setup window (`setup.html`)
4. If `kind === "app"`: start the local stack if mode is `"new"` → then show the main app window pointing at `localWebUrl`

**`src/setup-store.ts`**

- Read/write `userData/setup.json` (mode: `"new"` | `"existing"`, serverUrl, optional customHeaders)
- File written with `0o600` permissions
- Exported: `readSetup(): DesktopSetup | null`, `writeSetup(setup: DesktopSetup): void`, `clearSetup(): void`

**`src/setup-config.ts`**

- Mirror of rakazo's `setup-config.ts` adapted for Orbit:
  - `DEFAULT_LOCAL_WEB_URL = "http://127.0.0.1:8787"`
  - `normalizeServerUrl(input)`: accepts `localhost:8787`, `orbit.example.com`, or full URLs; normalizes to origin
  - `resolveStartupTarget({ envUrl?, saved? })`: env var `ORBIT_WEB_URL` wins; otherwise saved setup; otherwise show setup
  - `sessionPartitionForServerUrl(url)`: SHA-256 of origin → `persist:orbit-<24hex>`

**`src/app-window.ts`**

- `createAppWindow(url: string)`: `BrowserWindow` loading the given server URL, with `partition` from `sessionPartitionForServerUrl`
- Intercepts `will-navigate` and `new-window` to block external navigations
- Passes `x-orbit-desktop: 1` request header on every request to the server URL (lets the server send a `desktop.json` manifest for auto-update info)

**`src/app-menu.ts`**

- Application menu with: **Change Orbit Server…** (Cmd+Shift+K), **Stop Local Stack**, **Check for Updates…**, **Settings** (Cmd+,)
- `Change Orbit Server…` clears the saved setup and reopens the setup window

**`src/auto-update.ts`**

- `initAutoUpdate()`: wraps `electron-updater` `autoUpdater`
- Checks for updates on launch and every 4 hours
- Shows a non-modal `BrowserWindow` notification bar (not a dialog) when an update is ready: "Orbit update ready — Restart to install"
- Published to GitHub Releases via `electron-builder` publish config (owner/repo from `package.json`)

**`src/badge.ts`**

- On macOS: set dock badge count from server's `/api/events` SSE stream `unread` field
- On Windows: taskbar overlay icon
- Subscribes to the SSE stream after the app window is ready

### Phase 2-C: First-run setup window

**`src/setup.html`** + **`src/setup.ts`** — a self-contained HTML+TS renderer

The setup window is 540×420px, frameless on macOS, standard frame on Windows/Linux.

**Flow**:

```
┌─────────────────────────────────────────────────────┐
│                   Welcome to Orbit                  │
│                                                     │
│   ○ This computer                                   │
│     Run everything locally. Requires Docker.        │
│                                                     │
│   ○ Existing instance                               │
│     Connect to an Orbit server you already run.     │
│     [ https://orbit.example.com          ] [Check]  │
│                                                     │
│                            [ Continue → ]           │
└─────────────────────────────────────────────────────┘
```

- **This computer** selected by default
- **Existing instance** reveals a URL text input + Check button that probes `/api/health`
- **Continue** disabled until a valid choice is made
- Writes `setup.json` and sends `ipcMain` event `"setup-complete"` → main closes setup window, proceeds with startup

**`src/setup.css`**: dark/light tokens matching `@orbit/ui-tokens`

### Phase 2-D: Local stack controller (Docker Compose)

This mirrors rakazo's `local-stack.ts` and `docker-cli.ts`, adapted for Orbit's compose file.

**`src/docker-cli.ts`**

- `resolveDockerBinary(platform, env, exists)`: finds `docker` binary; on macOS checks `/usr/local/bin/docker`, `/usr/bin/docker`, the Docker Desktop socket path; on Windows checks `%PROGRAMFILES%\Docker\Docker\resources\bin\docker.exe`
- `classifyDockerFailure(output)`: returns `DockerFailureKind` — `"image-not-found" | "port-in-use" | "address-pool-exhausted" | "network" | "daemon-down" | "socket-permission" | "compose-missing" | "other"`
- `runDocker(binary, args, opts)`: `Promise<{ code, stdout, stderr }>` with timeout and AbortSignal

**`src/local-stack.ts`**\
State machine phases: `idle → checking-docker → docker-missing | docker-not-running | preparing → pulling → starting → waiting-healthy → ready | failed`

Key behaviors (all from rakazo analysis):

- `stackDir`: `userData/stack/`; `resourceDir`: `extraResources/stack/` in packaged builds
- Copies `docker-compose.yml` and `.env.example` from resources to `stackDir` on first run
- **Secret generation**: fills empty `KEY=` lines in `.env.example` with `crypto.randomBytes(n).toString('hex')`. Required secrets: `SESSION_SECRET` (32 bytes), `DB_ENCRYPTION_KEY` (32 bytes), `STACK_TOKEN` (32 bytes)
- **Port allocation**: `allocateLoopbackPort()` binds port 0 on 127.0.0.1 and releases it; falls back through up to 2 retries on `port-in-use` errors
- **Image tag**: packaged release builds pin to `v${version}`; dev builds use `edge`
- **Health probe**: `GET /api/health` with `x-orbit-stack-token: <token>` header; loops with 2s interval up to 120s timeout
- **`LocalStackController extends StackLifecycle`**: `start()`, `stop()`, `abort()`, `webUrl()`, `state()`, `matchesDesiredStack()`
- State changes pushed via `onState` callback → IPC to setup/main window

**`docker-compose.yml`** (bundled in `extraResources/stack/`):\
Services: `api` (the Orbit server image), `worker` (optional — if separated from API), `sandbox-supervisor` (Docker socket access; starts/stops bot containers)\
Port binding: `ORBIT_WEB_PORT` on 127.0.0.1 only; API port 0 (dynamic)\
Volumes: `orbit-data` for SQLite and engine homes

**`.env.example`** (bundled in `extraResources/stack/`):

```
SESSION_SECRET=
DB_ENCRYPTION_KEY=
STACK_TOKEN=
ORBIT_WEB_PORT=8787
ORBIT_API_PORT=0
HERMES_HOME=/root/.hermes
```

**`src/local-stack-networking.ts`**:

- `writeStackWebUrl(dir, url)` / `readStackWebUrl(dir, fallback)`
- `writeStackToken(dir, token)` / `readStackToken(dir)`

### Phase 2-E: Hermes setup

This is unique to Orbit (rakazo doesn't need this). Hermes is the agent harness every bot runs on.

**`src/hermes-setup.ts`**

**Detection**:

```typescript
export async function detectHermes(env: NodeJS.ProcessEnv): Promise<HermesStatus> {
  // 1. Check HERMES_BIN env var
  // 2. Check common paths: ~/.hermes/bin/hermes, /usr/local/bin/hermes, ~/.local/bin/hermes
  // 3. If found: run `hermes --version` to confirm
  // Returns: { found: false } | { found: true, version: string, home: string, hasApiKey: boolean }
}
```

**Installation**:\
If Hermes is not found, the setup window shows an extra step:

```
┌─────────────────────────────────────────────────────┐
│                 Hermes not found                    │
│                                                     │
│  Orbit needs Hermes Agent to run your bots.         │
│                                                     │
│  [ Install Hermes automatically ]                   │
│    Downloads the Hermes installer from              │
│    github.com/NousResearch/hermes-agent             │
│                                                     │
│  [ I'll install it myself ]                         │
│    Opens the Hermes install docs.                   │
└─────────────────────────────────────────────────────┘
```

`installHermes(onProgress: (line: string) => void)`:

1. Download the Hermes release for the current platform from the GitHub Releases API (`/releases/latest`)
2. Verify SHA256 checksum against the release's `.sha256` asset
3. Extract to `~/.hermes` (or `%APPDATA%/hermes` on Windows)
4. Add to PATH in shell profile (`.zshrc`, `.bashrc`, PowerShell profile)
5. Run `hermes init` to create the default home

**MCP wiring** (after stack is running):\
Runs `python3 /opt/orbit/scripts/add-orbit-to-hermes.py` (or the equivalent Node script) to add the Orbit MCP server entry to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  orbit:
    type: http
    url: http://127.0.0.1:8787/mcp/primary
    headers:
      Authorization: "Bearer <mcpToken>"
```

This mirrors the existing `scripts/add-hq-to-hermes.py` logic, ported to run from Electron's main process via `child_process.execFile`.

**API key check**:\
After Hermes is detected/installed, check `~/.hermes/.env` for `API_SERVER_KEY`. If absent, generate one and write it. Store a copy in the stack's `.env` as `HERMES_KEY=`.

**`src/hermes-setup-window.ts`**:\
If Hermes setup is needed, the first-run flow inserts a "Setting up Hermes…" step between "Choose server" and "Starting stack". Progress lines stream from the installer subprocess into the window via IPC.

### Phase 2-F: electron-builder config & CI

**`electron-builder.yml`**:

```yaml
appId: dev.orbit.desktop
productName: Orbit
directories:
  output: out
  buildResources: assets
files:
  - dist/**/*
  - package.json
extraResources:
  - from: ../web/dist
    to: web
  - from: ../../infra/compose/docker-compose.yml
    to: stack/docker-compose.yml
  - from: ../../infra/compose/.env.example
    to: stack/.env.example
mac:
  category: public.app-category.productivity
  target: [dmg, zip]
  notarize: true
  entitlements: assets/entitlements.mac.plist
win:
  target: [nsis]
linux:
  target: [AppImage]
publish:
  provider: github
  owner: <repo-owner>
  repo: orbit
```

**`.github/workflows/desktop-release.yml`**:\
Trigger: `push` to `v*` tags\
Matrix: `macos-latest` (arm64 + x64 universal), `windows-latest`, `ubuntu-latest`\
Steps: checkout, pnpm install, `pnpm --filter @orbit/web build`, `pnpm --filter @orbit/desktop release`\
Secrets: `APPLE_DEVELOPER_CERTIFICATE`, `APPLE_DEVELOPER_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, `GH_TOKEN`

### Phase 2-G: Preload & IPC contract

**`src/preload.cjs`** — exposes a typed `window.orbitDesktop` API to the renderer:

```typescript
interface OrbitDesktopAPI {
  // Stack
  getStackState(): DesktopLocalStackState
  startStack(): Promise<DesktopLocalStackState>
  stopStack(): Promise<DesktopLocalStackState>
  onStackState(cb: (state: DesktopLocalStackState) => void): () => void
  // Setup
  getSetup(): DesktopSetup | null
  saveSetup(setup: DesktopSetup): void
  clearSetup(): void
  // Hermes
  getHermesStatus(): Promise<HermesStatus>
  installHermes(onProgress: (line: string) => void): Promise<void>
  wireHermesMcp(token: string): Promise<void>
  // Updates
  checkForUpdates(): void
  onUpdateReady(cb: () => void): () => void
  restartAndInstall(): void
  // Platform
  platform: "darwin" | "win32" | "linux"
  version: string
}
```

**`src/session-permissions.ts`**: Electron `session.defaultSession.setPermissionRequestHandler` — allow microphone (for voice), block everything else with no dialog

---

## Part 3 — Expo Mobile App

**Prerequisites**: Part 1 complete\
**Works on**: `apps/mobile/` only — no overlap with Part 2 (desktop)\
**Output**: Expo app targeting iOS 16+ and Android 13+; EAS build config; connects to any Orbit server via URL; features: chat, VNC viewer, push notifications

### Phase 3-A: Expo scaffold

**`apps/mobile/package.json`** (`@orbit/mobile`):

```json
{
  "name": "@orbit/mobile",
  "version": "0.1.0",
  "main": "index.ts"
}
```

Dependencies: `expo@53`, `expo-router@4`, `@expo/ui@53`, `expo-notifications`, `expo-clipboard`, `expo-constants`, `expo-secure-store`, `expo-audio`, `@tanstack/react-query@5`, `zustand@5`, `@orbit/contracts` (workspace)

**`app.json`**:

```json
{
  "expo": {
    "name": "Orbit",
    "slug": "orbit",
    "version": "0.1.0",
    "ios": { "bundleIdentifier": "dev.orbit.app", "supportsTablet": true },
    "android": { "package": "dev.orbit.app" },
    "plugins": ["expo-router", "expo-notifications"]
  }
}
```

**`app.config.ts`**: mirrors rakazo's pattern — validates `EXPO_PUBLIC_API_URL` is HTTPS on release builds; injects `googleServicesFile` from env

**`eas.json`**:

```json
{
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview": { "distribution": "internal" },
    "production": {
      "ios": { "resourceClass": "m-medium" },
      "android": { "buildType": "apk" }
    }
  }
}
```

### Phase 3-B: Server connection & auth

**`lib/api.ts`**:\
Core fetch wrapper:

```typescript
export async function fetchOrbitJson<T>(
  url: string,
  init: RequestInit,
  opts: { timeoutMs?: number } = {},
): Promise<T>
```

- Attaches `Authorization: Bearer <sessionToken>` header from `lib/session.ts`
- Throws typed `OrbitApiError` on non-2xx
- Respects `AbortSignal` and timeout

**`lib/endpoint.ts`**:

- `defaultApiBase()`: reads `EXPO_PUBLIC_API_URL` from constants; falls back to `http://localhost:8787`
- `normalizeApiBase(raw)`: validates and normalizes user-entered server URL; returns `{ ok: true, url } | { ok: false, error }`
- `probeApiBase(url)`: `GET /api/health` with 5s timeout; returns `{ ok: boolean, version?: string }`
- `apiBaseWarning(url)`: returns a string warning if the URL is HTTP (not HTTPS) and not localhost

**`lib/session.ts`**:

- `saveSessionToken(token)`: stores in `expo-secure-store` under `orbit_session_token`
- `clearSessionToken()`: removes it
- `getSessionToken()`: reads it; returns `null` if absent

**`lib/api-server.ts`**:

- `saveApiBase(url)`: persists to `expo-secure-store` as `orbit_api_base`
- `resetApiBase()`: clears it
- `currentApiBase()`: reads saved value or `defaultApiBase()`

### Phase 3-C: Navigation structure (Expo Router)

```
app/
  _layout.tsx          — root layout: QueryClientProvider, ThemeProvider, AuthGate
  sign-in.tsx          — sign-in screen (email + password, or magic link)
  server.tsx           — custom server URL entry
  (tabs)/
    _layout.tsx        — bottom tab bar: Chats, Bots, Settings
    index.tsx          — chat list (all bots)
    bots.tsx           — bot roster
    settings.tsx       — app settings, server info, sign-out
  thread/[botId].tsx   — chat thread with one bot
  computer/[botId].tsx — VNC viewer for one bot's screen
  sign-out.tsx         — sign-out confirmation
```

**`app/_layout.tsx`**: reads `currentApiBase()` and `getSessionToken()`; redirects to `/sign-in` if no session, to `/server` if no API base configured

**`app/server.tsx`**: matches rakazo's server screen — text input for server URL, header rows editor for custom headers, "Check connection" button that calls `probeApiBase`, "Save" writes the base and navigates back

**`app/sign-in.tsx`**: POSTs to `/api/auth/sign-in` with `{ email, password }` → saves session token → redirects to `/(tabs)`

### Phase 3-D: Chat UI

**`lib/store.ts`** — Zustand store:

```typescript
interface OrbitMobileStore {
  bots: Bot[]
  threads: Record<string, MessageRow[]>  // botId → rows
  setBots(bots: Bot[]): void
  upsertRow(botId: string, row: MessageRow): void
  clearThread(botId: string): void
}
```

**`lib/sse.ts`** — SSE client:

```typescript
export function connectSSE(apiBase: string, token: string, onEvent: (e: EventPayload) => void): () => void
```

Wraps `EventSource` (or a polyfill for React Native). Dispatches to store's `upsertRow` / `setBots`. Reconnects on disconnect with exponential backoff (1s → 2s → 4s → max 30s).

**`app/(tabs)/index.tsx`** — chat list:

- `FlatList` of bots sorted by last message time
- Each row: bot avatar, name, last message preview, unread badge
- Swipe-to-clear unread (native iOS swipe action via `@expo/ui`)

**`app/thread/[botId].tsx`** — chat thread:

- `FlashList` (or `FlatList`) of `MessageRow` items, inverted (newest at bottom)
- Input composer: `TextInput` + send button + voice button (placeholder for voice, Phase 4)
- Activity indicator while `bot.status !== "idle"`
- Tool-call rows rendered as collapsible "Worked for Xs · N steps" chips (native disclosure)
- Approval cards: "Allow / Deny" buttons that POST to `/api/bots/:botId/approvals/:id`
- Send: POST `/api/bots/:botId/chat` with `{ message }` → SSE delivers the reply rows

**`components/message-bubble.tsx`**: renders markdown using a lightweight React Native markdown renderer. Handles code blocks with monospace font, links open in the system browser.

**`components/bot-avatar.tsx`**: renders the bot's SVG avatar shape+color using React Native SVG.

### Phase 3-E: VNC viewer

The VNC viewer lets the user watch (and optionally control) a bot's screen live.

**`app/computer/[botId].tsx`**:

The viewer is a full-screen `WebView` loading a bundled noVNC client. This avoids reimplementing VNC decoding in React Native.

Approach:

1. Bundle a minimal noVNC HTML page as an asset (`assets/vnc-viewer/index.html`) — same noVNC library the web app uses, stripped of the toolbar, resized to 100%/100%
2. `WebView` with `source={{ uri: ... }}` loading it from an asset URL
3. Pass the VNC WebSocket URL to the page via `injectedJavaScript` or query param: `?wsUrl=wss://...&token=...`
4. The WebView's noVNC connects to the server's VNC WebSocket relay (`/api/bots/:botId/vnc`)

**Read-only by default**: keyboard/pointer events suppressed unless user taps a "Take control" button (native sheet confirmation).

**Native header**: back button + "Take control" toggle + fullscreen button (iOS: `useFullscreen()` from expo-router; Android: system flags).

**`lib/vnc-url.ts`**:

```typescript
export function vncWebSocketUrl(apiBase: string, botId: string, token: string): string {
  // Converts http(s) → ws(s), appends /api/bots/:botId/vnc?token=:token
}
```

### Phase 3-F: Push notifications

**Server side** (in `apps/server/src/`):\
Add `apps/server/src/push.ts`:

```typescript
export async function sendPushNotification(userId: string, payload: PushPayload): Promise<void>
```

- Reads registered push tokens from `push_tokens` table (new table: `CREATE TABLE push_tokens (id TEXT PRIMARY KEY, user_id TEXT, token TEXT, platform TEXT, created_at INTEGER)`)
- Sends via Expo Push API (`https://exp.host/--/api/v2/push/send`) — no APNs/FCM credentials needed for Expo Go and development; production builds need EAS push credentials
- Called from `apps/server/src/agent/loop.ts` on turn completion and when an approval card is created

Add `/api/push/register` endpoint: `POST { token: string, platform: "ios" | "android" }` — saves or updates the push token for the authenticated user.

**Client side**:\
**`lib/push.ts`**:

```typescript
export async function registerPushNotifications(): Promise<void> {
  // 1. requestPermissionsAsync()
  // 2. getExpoPushTokenAsync({ projectId: Constants.expoConfig.extra.eas.projectId })
  // 3. POST /api/push/register with { token, platform }
}
```

Called once from `app/_layout.tsx` on successful sign-in.

**Notification handler** (`app/_layout.tsx`):

```typescript
Notifications.addNotificationResponseReceivedListener((response) => {
  const { botId } = response.notification.request.content.data;
  router.push(`/thread/${botId}`);
});
```

**Notification content** (server-side):

```typescript
{
  to: pushToken,
  title: `${botName} needs your input`,
  body: truncate(lastMessage, 80),
  data: { botId },
  sound: "default",
}
```

### Phase 3-G: Native appearance & tokens

**`lib/native.ts`**:

```typescript
export function useMobileTokens(): MobileTokens
// Returns colors from @orbit/ui-tokens adapted to React Native's PlatformColor,
// with automatic light/dark switching via useColorScheme()
```

**`lib/appearance.ts`**:

```typescript
export const palette = {
  bg: PlatformColor({ ios: { light: '#FFFFFF', dark: '#000000' }, android: ... }),
  fg: PlatformColor(...),
  accent: PlatformColor(...),
  // ...
}
```

Native controls: use `@expo/ui` `Sheet`, `ContextMenu`, `Switch`, `Picker` wherever a native control exists. Fall back to custom `StyleSheet` components only for chat-specific surfaces (message bubbles, composer, bot avatar).

---

## Part 4 — Server API Extensions

**Prerequisites**: Part 1 complete\
**Works on**: `apps/server/src/` only\
**Output**: New API endpoints and enhanced existing ones to support the desktop and mobile clients

### Phase 4-A: Health probe enhancement

The desktop app's local stack controller needs a richer health probe response.

Update `GET /api/health` response:

```json
{
  "ok": true,
  "version": "0.1.0",
  "engine": "hermes",
  "stackToken": "<validated if x-orbit-stack-token header present>"
}
```

Add a separate `GET /api/desktop/probe` endpoint (authenticated with `x-orbit-stack-token` header) that returns:

```json
{
  "ok": true,
  "imageTag": "v0.1.0",
  "hermesConnected": true
}
```

Used by `LocalStackController.matchesDesiredStack()`.

### Phase 4-B: Push notification infrastructure

New table migration (`apps/server/src/db.ts`):

```sql
CREATE TABLE IF NOT EXISTS push_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_tokens_user ON push_tokens(user_id);
```

New file `apps/server/src/push.ts` (see Phase 3-F above for interface). Expo Push API client — no SDK needed, just `fetch` to `https://exp.host/--/api/v2/push/send`.

New route in `apps/server/src/routes.ts`:

```
POST /api/push/register   { token, platform } → upserts push_tokens row
DELETE /api/push/register                      → removes all tokens for user
```

Trigger dispatch in `apps/server/src/agent/loop.ts`:

- After a turn completes (`kind === "message"` with `role === "assistant"`): notify if user is not connected via SSE
- When an approval card is emitted: always notify (the user needs to act)

### Phase 4-C: Mobile-friendly SSE

The existing `GET /api/events` SSE stream works for the web client but needs two additions for mobile:

1. **Reconnection cursor**: accept `?since=<seq>` query param; replay missed `roster`, `computer`, and recent `message` events since that sequence number. This lets the mobile client reconnect after backgrounding without losing events.
2. **Connection tracking**: add an in-memory set of active SSE connections per user; when a user has no active SSE connections, push notifications are delivered; when they do, skip the push (avoid duplicate notifications).

Changes to `apps/server/src/lib/hub.ts`:

- `hub.connections(userId): number` — count of active SSE subscribers
- `hub.since(userId, seq): EventPayload[]` — events since a given sequence (keep a rolling 5-minute buffer in memory per user)

### Phase 4-D: Desktop-specific API

Add `GET /api/desktop/config` (requires `x-orbit-desktop: 1` header + valid session):

```json
{
  "updateCheckUrl": "https://api.github.com/repos/<owner>/orbit/releases/latest",
  "features": { "voice": true, "pushNotifications": false },
  "maxBots": 4
}
```

This lets the desktop app know server-side feature flags without hardcoding them.

---

## Part 5 — Infra & Docker Compose

**Prerequisites**: Part 1 and Part 4-A complete\
**Works on**: `infra/` only\
**Output**: Production-ready Docker Compose files and installer script for the desktop app's local stack

### Phase 5-A: Compose files

**`infra/compose/docker-compose.yml`** (for source-based development):

```yaml
services:
  api:
    build: { context: ../../apps/server, dockerfile: Dockerfile }
    environment: [SESSION_SECRET, DB_ENCRYPTION_KEY, HERMES_URL, ...]
    ports: ["127.0.0.1:8787:8787"]
    volumes: ["orbit-data:/data"]
  sandbox-supervisor:
    build: { context: ../../apps/server, dockerfile: Dockerfile.supervisor }
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
    environment: [SANDBOX_SUPERVISOR_TOKEN]
volumes:
  orbit-data:
```

**`infra/compose/docker-compose.images.yml`** (bundled with the desktop app — uses published images):

```yaml
services:
  api:
    image: ghcr.io/<owner>/orbit/app:${ORBIT_IMAGE_TAG:-edge}
    env_file: .env
    ports: ["127.0.0.1:${ORBIT_WEB_PORT:-8787}:8787"]
    volumes: ["orbit-data:/data"]
  sandbox-supervisor:
    image: ghcr.io/<owner>/orbit/app:${ORBIT_IMAGE_TAG:-edge}
    command: [node, dist/supervisor.js]
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
    env_file: .env
volumes:
  orbit-data:
```

**`infra/compose/.env.images.example`**:

```
ORBIT_IMAGE_TAG=
ORBIT_WEB_PORT=8787
ORBIT_API_PORT=0
SESSION_SECRET=
DB_ENCRYPTION_KEY=
STACK_TOKEN=
HERMES_HOME=/root/.hermes
HERMES_KEY=
```

### Phase 5-B: Server Dockerfile

**`apps/server/Dockerfile`**:

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/ packages/
COPY apps/server/ apps/server/
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @orbit/server build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/apps/server/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
```

### Phase 5-C: GitHub Actions — image publish

**`.github/workflows/publish-images.yml`**:\
Trigger: `push` to `main` and `v*` tags\
Steps:

1. `docker/setup-buildx-action` with `platforms: linux/amd64,linux/arm64`
2. Build and push `ghcr.io/<owner>/orbit/app:<tag>` (tag = `edge` for `main`, `v<version>` for release)
3. Build and push `ghcr.io/<owner>/orbit/computer:<tag>` (the bot sandbox image, from `apps/server/docker/computer/`)

---

## Part 6 — Mac Native Server Bundle (Apple Silicon, macOS 26+)

**Prerequisites**: Part 2 complete (Electron scaffold + `LocalStackController` exists)\
**Works on**: `apps/desktop/src/` only — no overlap with other parts\
**Output**: On eligible Macs, the desktop app runs the Orbit server as supervised Node processes (via `ELECTRON_RUN_AS_NODE=1`) without Docker; Docker Compose remains the path on Windows, Linux, and older macOS

> **Why this is simpler than rakazo's native path**: Orbit uses SQLite, not Postgres. There is no database VM to boot, health-check, or migrate. The native stack is just two supervised processes (API + web static server) and an optional container runtime for bot VMs. Migration from Docker to native is a file copy.

---

### Phase 6-A: Eligibility check (`src/mac-runtime.ts`)

**`nativeStackEligible()`**:

```typescript
export function nativeStackEligible(): boolean {
  if (process.platform !== "darwin") return false;
  if (process.arch !== "arm64") return false;
  const darwinMajor = parseInt(os.release().split(".")[0], 10);
  return darwinMajor >= 25; // macOS 26 = Darwin 25
}
```

**`downloadVerified(url, sha256, size, destPath)`**:

- Streams the download to a `.tmp` file
- Tracks bytes received; rejects if `size` bytes not received
- Computes SHA-256 incrementally via `crypto.createHash`
- On mismatch: deletes `.tmp` and throws `DownloadVerifyError`
- On match: `fs.rename(tmpPath, destPath)` atomically

**`installServerBundle(manifest: ServerManifest, destDir: string)`**:

- Downloads `manifest.download.url` using `downloadVerified()`
- Extracts `.tar.xz` via `tar -xJf` to `destDir/orbit-server-<version>/`
- Writes `destDir/current` symlink pointing to the new version
- Keeps previous version; calls `pruneServerBundles(destDir, keep=2)`

**`ServerManifest` interface** (embedded in `.app` as `Resources/server-bundle.json`):

```typescript
interface ServerManifest {
  version: string;
  download: { url: string; sha256: string; size: number };
  entrypoints: {
    api: string;      // relative path, e.g. "dist/index.js"
    migrate: string;  // e.g. "dist/migrate.js"
  };
}
```

**Container runtime** (for bot VMs only — Orbit's Docker computers):

- `resolveContainerRuntime()`: checks for Apple `container` CLI at known paths; returns path or `null`
- `installContainerRuntime(version, progressCb)`: downloads from Apple's GitHub release, verifies signature via `codesign -v`, installs to `~/Library/Containers/com.apple.container/`
- `CONTAINER_RUNTIME_VERSION = "1.7.1"` — only needed for running Docker-format bot images; the Orbit server itself needs no container runtime
- `verifyRuntimeSignature(binaryPath)`: calls `codesign --verify --deep` and checks Apple Team ID in cert chain

---

### Phase 6-B: Native stack controller (`src/native-stack.ts`)

`NativeStackController` implements the same `StackController` interface as `LocalStackController` (same `webUrl()`, `state()`, `start()`, `stop()`, `abort()`, `matchesDesiredStack()`) — the setup window and app window code are **unchanged**.

**`Service` class** (supervised Node process):

```typescript
class Service {
  private proc: ChildProcess | null = null;
  private restartCount = 0;

  async start(spec: ServiceSpec): Promise<void>
  async stop(): Promise<void>
  private onExit(code: number | null): void  // crash-restart with backoff
}
```

Crash-restart backoff: `restartDelay(count) = Math.min(1000 * 2 ** count, 30_000)` ms (1s, 2s, 4s … 30s max). Logs to `userData/stack/logs/<name>.log` via `fs.createWriteStream` in append mode.

**`NativeStackController` state machine** (same states as `LocalStackController`):

```
idle → starting → running → stopping → stopped
                          ↘ failed
```

`start()` sequence:

1. Run migrations: `ELECTRON_RUN_AS_NODE=1 <electronBinary> <bundle>/dist/migrate.js`
2. Allocate ports (read `.native-ports` file or pick two random loopback ports 40000–49999 not in use; write back)
3. Spawn API service: `ELECTRON_RUN_AS_NODE=1 <electronBinary> <bundle>/dist/index.js` with env `PORT`, `DB_PATH`, `ENGINES_DIR`, `SESSION_SECRET`, `HERMES_HOME`, etc.
4. Poll `GET http://127.0.0.1:<apiPort>/api/health` every 500ms up to 30s
5. Spawn web static server if the bundle includes one (optional — can serve web via `api` process itself)
6. Transition to `running`

**`.native-ports` file** (`userData/stack/.native-ports`):

```json
{ "api": 42001, "web": 42000 }
```

Persisted so the web URL stays stable across launches. On port-in-use: pick new ports, overwrite file.

**Environment for spawned processes**:

```typescript
const stackEnv = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1",
  NODE_ENV: "production",
  PORT: String(ports.api),
  WEB_PORT: String(ports.web),
  DB_PATH: path.join(userData, "orbit.db"),
  ENGINES_DIR: path.join(userData, "engines"),
  SESSION_SECRET: await ensureSecret("session_secret"),
  HERMES_HOME: hermesHome,
};
```

`ensureSecret(name)` reads from `userData/stack/secrets.json`; generates a 32-byte random hex string on first call and writes it back.

---

### Phase 6-C: Docker migration (`src/docker-move.ts`)

**Files**:

- `STACK_CHOICE_FILE = path.join(userData, ".desktop-stack-choice")`
- `NATIVE_PORTS_FILE = path.join(userData, "stack", ".native-ports")`

**`StackChoice`**: `"docker" | "native"`

**`readStackChoice() / writeStackChoice(choice)`**: reads/writes the `.desktop-stack-choice` file. Absent = no choice made yet.

**`chooseStack()`** called from `main.ts` on first run on an eligible Mac:

```
if nativeStackEligible() AND serverBundleExists():
  choice = readStackChoice()
  if choice === "docker": return "docker"
  if choice === "native": return "native"
  // First time on eligible Mac — check if a Docker stack already exists
  if dockerDataExists():
    show "Run without Docker?" dialog (see below)
  else:
    writeStackChoice("native"); return "native"
```

**"Run without Docker?" dialog** (shown once when an existing Docker stack is detected on an eligible Mac):

```
┌─────────────────────────────────────────────────────┐
│          Run Orbit without Docker?                  │
│                                                     │
│  This Mac supports a faster, Docker-free mode.      │
│  Your bots and data will be copied over.            │
│                                                     │
│  Docker must be running to copy your data.          │
│                                                     │
│  [ Keep Docker ]    [ Switch (recommended) ]        │
└─────────────────────────────────────────────────────┘
```

**`moveAccepted()`** — called when user clicks "Switch":

1. Assert Docker stack is running (prompt to start it if not)
2. Acquire SQLite WAL checkpoint: `PRAGMA wal_checkpoint(TRUNCATE)` via `better-sqlite3`
3. `cp <dockerDataDir>/orbit.db <userData>/orbit.db` (atomic copy via `.tmp` + rename)
4. `cp -r <dockerDataDir>/engines <userData>/engines` (recursive)
5. `cp -r <dockerDataDir>/computer-homes <userData>/computer-homes`
6. Write `writeStackChoice("native")`
7. Stop Docker stack: `docker compose down` (without `-v` — data stays in Docker volumes for rollback)
8. Transition to native

**`dockerDataExists()`**: checks for `userData/docker/orbit.db` or the Docker volume named `orbit_data`.

**Rollback**: Docker stack not removed (`down` without `-v`). User can switch back via **Change Stack…** in the app menu (new menu item, only shown on eligible Macs that have a saved Docker stack).

---

### Phase 6-D: CI — server bundle build job

**`.github/workflows/desktop-release.yml`** — add new job `build-server-bundle` that runs in parallel with the existing `build-desktop` job:

```yaml
build-server-bundle:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with: { node-version: '22' }
    - run: pnpm install --frozen-lockfile
    - run: pnpm --filter @orbit/server build
    - run: pnpm --filter @orbit/web build
    - name: Pack server bundle
      run: |
        mkdir -p bundle/dist bundle/web
        cp -r apps/server/dist bundle/dist
        cp -r apps/web/dist bundle/web
        # Write bundle manifest
        VERSION=$(node -p "require('./apps/server/package.json').version")
        echo "{\"version\":\"$VERSION\",\"entrypoints\":{\"api\":\"dist/index.js\",\"migrate\":\"dist/migrate.js\"}}" \
          > bundle/bundle-manifest.json
        tar -cJf orbit-server-$VERSION.tar.xz -C bundle .
        SHA=$(shasum -a 256 orbit-server-$VERSION.tar.xz | awk '{print $1}')
        SIZE=$(wc -c < orbit-server-$VERSION.tar.xz)
        echo "{\"version\":\"$VERSION\",\"download\":{\"url\":\"https://github.com/\${{ github.repository }}/releases/download/v$VERSION/orbit-server-$VERSION.tar.xz\",\"sha256\":\"$SHA\",\"size\":$SIZE}}" \
          > server-bundle.json
    - name: Upload to release
      uses: softprops/action-gh-release@v2
      with:
        files: |
          orbit-server-${{ env.VERSION }}.tar.xz
          server-bundle.json
```

**`build-desktop` job update**: copies `server-bundle.json` into `apps/desktop/resources/` before running `electron-builder`, so it is embedded in the `.app` as an `extraResources` file.

**`electron-builder.yml` update**:

```yaml
extraResources:
  - from: resources/web/
    to: web/
  - from: resources/server-bundle.json
    to: server-bundle.json
```

The desktop app reads `server-bundle.json` at startup from `process.resourcesPath` (Electron's resources directory).

---

### Phase 6-E: Wiring into `main.ts`

**Updated startup logic** in `src/main.ts`:

```typescript
async function selectStackController(): Promise<StackController> {
  if (!nativeStackEligible()) return new LocalStackController();

  const bundlePath = path.join(process.resourcesPath, "server-bundle.json");
  const hasBundle = fs.existsSync(bundlePath);
  if (!hasBundle) return new LocalStackController();

  const choice = await chooseStack(); // handles first-run dialog
  if (choice === "docker") return new LocalStackController();

  const manifest: ServerManifest = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const bundleDir = path.join(app.getPath("userData"), "server-bundles");
  await installServerBundle(manifest, bundleDir); // no-op if already installed
  return new NativeStackController(manifest, bundleDir);
}
```

**Menu additions** (in `src/app-menu.ts`):

- On eligible Macs with a bundle: show **Stack: Native (Docker-free)** as a greyed status item
- **Switch to Docker…** / **Switch to Native…** menu item (shown when both stacks are available), which calls `writeStackChoice()` and restarts the stack

---

### Phase 6-F: Integration and testing

**Unit tests** (`apps/desktop/src/__tests__/`):

- `nativeStackEligible.test.ts`: mock `os.release()` and `process.arch`; test Darwin 24 returns false, Darwin 25 arm64 returns true, x64 returns false
- `downloadVerified.test.ts`: mock HTTP server serving a known file; test hash match succeeds, hash mismatch throws and deletes temp file
- `dockerMove.test.ts`: mock `better-sqlite3` and `child_process`; test `moveAccepted()` sequence (checkpoint → copy → writeChoice → down)
- `nativeStack.test.ts`: mock `child_process.spawn`; test startup sequence (migrate → spawn API → health poll → running), crash-restart delay, clean stop

**E2E / smoke test** (macOS arm64 only, skipped on other platforms):

- `nativeStack.e2e.ts`: actually spawns the API process against a test database, polls health, makes one API call, stops
- Gated by `process.env.ORBIT_NATIVE_E2E === "1"` so it doesn't run in normal CI

---

### Part 6 — Key design decisions

| Decision | Rationale |
| --- | --- |
| `ELECTRON_RUN_AS_NODE=1` | Avoids bundling a separate Node binary; the Electron binary acts as Node for server processes. Same pattern as rakazo. |
| No database VM | Orbit uses SQLite. The native path skips the entire Postgres VM lifecycle that makes rakazo's native path complex. |
| SQLite file copy for migration | `cp` + `PRAGMA wal_checkpoint` is atomic and reversible. No schema migration needed — same schema, different host. |
| Container runtime optional | Only needed if the user creates Docker-format bot VMs. The API server itself needs no container runtime. |
| `.native-ports` file | Keeps the web URL stable across app launches, preventing session-partition churn in Electron. |
| Bundle embedded in `.app` | `server-bundle.json` ships with the `.app` so the app knows where to download the bundle without a network round-trip at startup. The bundle itself is downloaded on first launch (lazy). |
| Rollback via Docker stack intact | `docker compose down` (not `down -v`) leaves Docker volumes intact so users can switch back without data loss. |

---

## Parallelization map

```
Part 1 (Monorepo)
   ↓ unblocks all others
   ├── Part 2 (Desktop)   ──────────────────── independent of Parts 3, 4, 5
   │     └── Part 6 (Mac Native Bundle) ────── depends on Part 2; macOS arm64 only
   ├── Part 3 (Mobile)    ──────────────────── independent of Parts 2, 4, 5
   ├── Part 4 (Server API) ─────────────────── independent of Parts 2, 3, 5
   └── Part 5 (Infra)     ─────────────────── depends on Part 4-A; independent of 2, 3
```

After all parts complete: integration testing (desktop ↔ server, mobile ↔ server).

---

## Key decisions carried from rakazo analysis

| Rakazo pattern | Applied in Orbit |
| --- | --- |
| Electron wraps the web app as a renderer; no separate desktop UI | Same: `apps/web/dist` served as `extraResources/web` |
| `LocalStackController` state machine for Docker Compose lifecycle | Ported verbatim, adapted for Orbit's compose file and secrets |
| First-run setup window (This computer / Existing instance) | Same flow, Orbit branding |
| `sessionPartitionForServerUrl` for per-server cookie isolation | Ported to `src/setup-config.ts` |
| `electron-updater` → GitHub Releases | Same publish config |
| Mobile is a pure client — connects to any server URL | Same: `lib/endpoint.ts` + `app/server.tsx` |
| Expo Router + `@expo/ui` native controls | Same stack |
| Push via Expo Push API (no direct APNs/FCM credentials in dev) | Same: `src/push.ts` |
| `missingStackSecrets()` appends secrets added in later versions | Ported to `src/local-stack.ts` |
| Docker app auto-launch on "not running" state | Ported to `src/local-stack.ts` |

---

## What is **not** in scope (intentional)

- Voice on mobile (xAI realtime WebRTC) — added after chat is stable
- Mobile VNC control mode (keyboard input) — read-only viewer first, control toggle in a follow-up
- Fleet management / multi-server mobile UI — single server per session for v1
- Passkeys / Face ID auth — session tokens first; passkeys in a follow-up
- Mobile routines editor — read-only view of routines, creation stays on web/desktop