# Computer-per-bot: Docker Implementation Plan

**Goal:** Give each managed bot its own isolated Docker container (X11 + VNC + Chromium), while keeping the existing Orgo path for the primary bot. Abstract both behind a shared `ComputerProvider` interface.

**Scale:** 5–10 bots max. All local Docker.

---

## Architecture overview

```
                   ┌─────────────────────────────────┐
                   │          orbit-app server         │
                   │                                   │
  computer.ts ─────┤──► ComputerProvider interface     │
  box.ts       ────┤──►   OrgoProvider  │  DockerProvider │
  vnc.ts        ───┤──► VNC relay (unified)            │
                   └──────────────┬──────────────────┘
                                  │ docker exec / dockerode
                         ┌────────▼────────────────┐
                         │  Bot containers (per bot) │
                         │  X11 :1  VNC :5901  CDP  │
                         │  Chromium  /home/bot      │
                         └───────────────────────────┘
```

**Key design principles:**
- `desk.ts` is unchanged — it already calls `box.bash` / `box.writeFile`, which we make provider-aware
- `vnc.ts` gains a Docker path: connects to a container's local VNC port instead of Orgo's websockify
- `computer.ts` becomes the `OrgoProvider` implementation
- State lives in a new `computers` SQLite table

---

## Phase 1 — `ComputerProvider` abstraction

### 1.1 New file: `server/src/computer-provider.ts`

Define the provider-neutral interface that both Orgo and Docker implement:

```ts
export interface ComputerRef {
  computerId: string;    // internal ID (botId for Docker, Orgo ID for Orgo)
  kind: 'orgo' | 'docker';
}

export interface ScreenRef {
  screenId: string;      // e.g. 'default', 'screen-1'
  vncPort?: number;      // Docker only: host port for VNC
  viewToken?: string;    // Docker only: auth token for screen
  cdpPort?: number;      // Chrome DevTools Protocol port (Docker: 9201+)
}

export interface BashResult { output: string; exit_code: number }

export interface ComputerProvider {
  /** Provision / resume the bot's computer. Idempotent. */
  ensureComputer(botId: string): Promise<ComputerRef>;

  /** Get (or create) a screen for the bot on its computer. */
  screenFor(userId: string, botId: string): Promise<{ computerId: string; screenId: string }>;

  /** Ensure a screen is set up and dressed for the bot. */
  readyScreen(userId: string, botId: string): Promise<void>;

  /** Run a bash command on the bot's screen. */
  bash(botId: string, command: string, timeoutSec?: number, screenId?: string | null): Promise<BashResult>;

  /** Write a file to the bot's computer. */
  writeFile(botId: string, file: string, content: string | Buffer, mode?: string): Promise<void>;

  /** Read a file from the bot's computer. */
  readFile(botId: string, file: string): Promise<Buffer | null>;

  /** URL for Chrome DevTools (CDP) on this bot's screen. */
  cdpUrl(botId: string, screenId: string): Promise<string>;

  /** Open a VNC WebSocket connection upstream (called by vnc.ts relay). */
  vncConnect(botId: string, screenId: string): Promise<WebSocket>;

  /** Let a human take interactive control of the screen (disable bot input). */
  takeControl(botId: string, screenId: string): Promise<void>;

  /** Return control to the bot. */
  giveControl(botId: string, screenId: string): Promise<void>;

  /** Suspend the container (save state, free resources). */
  suspend(botId: string): Promise<void>;

  /** Destroy the container and optionally its workspace. */
  destroy(botId: string, opts?: { wipeWorkspace?: boolean }): Promise<void>;
}
```

### 1.2 Refactor `computer.ts` → `OrgoComputerProvider`

- Rename / wrap the existing exports from `computer.ts` into a class `OrgoComputerProvider implements ComputerProvider`
- Keep all existing logic intact; just implement the interface methods
- `bash` / `writeFile` / `readFile` delegate to current `box.ts` Orgo path

### 1.3 Make `box.ts` provider-aware

`box.ts` currently has two paths: `HQ_LOCAL=1` (local exec) and Orgo. Add a third: **Docker exec**.

```ts
// box.ts additions
export type BoxTarget =
  | { kind: 'local' }
  | { kind: 'orgo'; computerId: string }
  | { kind: 'docker'; containerId: string };

/** Build a box bound to a specific target (Docker container or Orgo computer). */
export function boxFor(target: BoxTarget): Box { ... }
```

The `desk.ts` functions already take a `screenId` and call `box.*` globally. After this change:
- Primary bot (Orgo / local) → uses existing global `box` (unchanged)
- Managed Docker bots → pass their container's `Box` instance into `dressScreen` / `resetScreen`
- **`desk.ts` requires no changes** — only its callers change to pass the right box

### 1.4 Wire up a provider registry

```ts
// server/src/computer-provider-registry.ts
let orgoProvider: OrgoComputerProvider;
let dockerProvider: DockerComputerProvider;

export function providerFor(botId: string): ComputerProvider {
  const kind = getComputerKind(botId); // read from computers table
  return kind === 'docker' ? dockerProvider : orgoProvider;
}
```

---

## Phase 2 — SQLite schema: `computers` table

Add to the database migration:

```sql
CREATE TABLE IF NOT EXISTS computers (
  bot_id       TEXT PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'orgo',  -- 'orgo' | 'docker'
  state        TEXT NOT NULL DEFAULT 'stopped', -- 'stopped'|'booting'|'running'|'suspending'|'suspended'|'error'
  container_id TEXT,           -- Docker container ID (docker kind only)
  home_path    TEXT,           -- absolute path to bot's home dir on host
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS computer_screens (
  bot_id        TEXT NOT NULL,
  screen_id     TEXT NOT NULL,
  display_index INTEGER NOT NULL,  -- X11 display number (:1, :2, …)
  vnc_port      INTEGER,           -- host VNC port (5900 + display_index)
  cdp_port      INTEGER,           -- Chrome DevTools port (9200 + display_index)
  view_token    TEXT,              -- VNC auth token
  control_token TEXT,              -- human control token (set when taken)
  idle_at       TEXT,              -- last idle timestamp (for screen eviction)
  PRIMARY KEY (bot_id, screen_id)
);
```

Add migration in `db-config.ts` alongside existing schema setup.

---

## Phase 3 — Docker container management

### 3.1 New directory: `server/src/docker/`

#### `server/src/docker/image.ts`
- Reference to Rakazo's `COMPUTER_IMAGE` (from `third-party/rakazo`)
- `ensureComputerImage()` — pull image if not present
- Export `COMPUTER_IMAGE` constant (read from env `COMPUTER_IMAGE` or default to Rakazo's image tag)

#### `server/src/docker/container.ts`

Core container lifecycle using `dockerode`:

```ts
export interface ContainerSpec {
  botId: string;
  homePath: string;        // host path for /home/bot volume mount
  timezone?: string;
  language?: string;
}

/** Create and start a container for a bot. Returns container ID. */
export async function createBotContainer(spec: ContainerSpec): Promise<string>

/** Start an existing stopped container. */
export async function startContainer(containerId: string): Promise<void>

/** Stop a container gracefully (SIGTERM, then SIGKILL after 10s). */
export async function stopContainer(containerId: string): Promise<void>

/** Remove a container. Must be stopped first. */
export async function removeContainer(containerId: string): Promise<void>

/** Find a bot's container by botId label. Returns null if none. */
export async function findBotContainer(botId: string): Promise<Docker.Container | null>
```

Container create options (adapted from Rakazo's `containerCreateOptions`):
- Image: `COMPUTER_IMAGE`
- Labels: `{ 'orbit.botId': botId }`
- Mounts: `/home/bot` → `homePath` (bind mount)
- Security options: `no-new-privileges`, seccomp profile
- Devices: `/dev/dri` if present (GPU acceleration)
- Network: `none` by default (can be configurable per-bot)
- CPU/memory limits: 2 CPUs, 2GB RAM (configurable via env)
- Restart policy: `no` (orbit-app manages restarts)

#### `server/src/docker/exec.ts`

```ts
/** Run a command inside a container. Returns stdout, stderr, exit code. */
export async function execInContainer(
  containerId: string,
  cmd: string[],
  env?: Record<string, string>,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; code: number }>

/** Stream a command inside a container (for long-running commands). */
export async function execStreaming(
  containerId: string,
  cmd: string[],
  onChunk: (chunk: string) => void,
): Promise<number>
```

#### `server/src/docker/workspace.ts`

Checkpoint/restore the bot's home folder so Chrome logins persist:

```ts
const WORKSPACE_DIR = path.join(env.enginesDir, 'workspaces');
const workspacePath = (botId: string) => path.join(WORKSPACE_DIR, `${botId}.tar.gz`);

/**
 * Save bot's home directory to a compressed tarball.
 * Excludes Chrome cache dirs to keep the archive small.
 */
export async function checkpointWorkspace(botId: string, homePath: string): Promise<void>

/**
 * Restore a saved workspace into homePath.
 * No-op if no checkpoint exists yet.
 */
export async function restoreWorkspace(botId: string, homePath: string): Promise<void>

/** Home directory path on the host for a given bot. */
export function homeDirFor(botId: string): string {
  return path.join(env.enginesDir, 'homes', botId);
}
```

Checkpoint excludes (following Rakazo's pattern):
- `.cache/`
- `.config/chromium/Default/Cache/`
- `.config/chromium/Default/Code Cache/`
- `/tmp/`

---

## Phase 4 — Screen management (X11 + VNC per screen)

### 4.1 New file: `server/src/docker/screen.ts`

Port Rakazo's screen management from `supervisor-logic.ts` and `screens.ts`, adapted to use SQLite instead of Postgres:

```ts
/** Port assignments for a display index. */
export function screenPorts(index: number) {
  return {
    display: `:${index + 1}`,           // :1, :2, …
    displayNumber: index + 1,
    vncPort: 5900 + index + 1,          // 5901, 5902, …
    cdpPort: 9200 + index + 1,          // 9201, 9202, …
    noVncPort: 6080 + index + 1,        // 6081, 6082, … (noVNC proxy if used)
  };
}

/** Assign a screen index to a bot (or find its existing one). */
export function nextScreenIndex(
  screens: Map<string, { index: number }>,
  screenKey: string,
  limit: number,
): number

/**
 * Ensure the X11 display + VNC server + Chromium are running on the given display index.
 * Runs `ensure-screen.sh <index> <screenKey> <viewToken>` inside the container.
 * Returns the view token to use for VNC auth.
 */
export async function ensureScreen(
  containerId: string,
  index: number,
  screenKey: string,
  viewToken: string,
): Promise<void>

/**
 * Reset all screens on a container boot (kill stale Xvfb/VNC/Chrome processes).
 * Called once on first use after a container start.
 */
export async function resetScreens(containerId: string): Promise<void>

/** Tear down a specific screen (stop VNC + Chrome for that display). */
export async function teardownScreen(containerId: string, index: number, screenKey: string): Promise<void>
```

Screen bash commands inside the container (adapted from Rakazo's `ensureScreenCommand` / `resetManagedScreensCommand`):

```bash
# ensure-screen logic (runs inside container as a one-liner):
# 1. Start Xvfb on :N if not running
# 2. Start x11vnc on the display (with viewToken as password)  
# 3. Start Chromium on :N with --remote-debugging-port=CDP_PORT
#    --user-data-dir=/home/bot/.config/chromium/profile-SCREEN_KEY
# 4. Echo "SCREEN_OK" on success
```

### 4.2 VNC port allocation

Since containers share the host network, VNC ports must not collide:
- Track allocated ports in the `computer_screens` table (`vnc_port` column)
- Port range: `5901–5950` (supports 50 screens; well within 5–10 bot limit)
- Allocate at screen creation, free on screen teardown

---

## Phase 5 — `DockerComputerProvider`

### New file: `server/src/docker-provider.ts`

Implements `ComputerProvider` using the docker/ modules above:

```ts
export class DockerComputerProvider implements ComputerProvider {

  async ensureComputer(botId: string): Promise<ComputerRef> {
    // 1. Check computers table — if running and container exists, return
    // 2. If stopped/suspended: restoreWorkspace, startContainer (or createBotContainer)
    //    update state to 'booting', resetScreens(), update state to 'running'
    // 3. If booting (crash recovery): wait or force-restart
  }

  async screenFor(userId: string, botId: string): Promise<{ computerId: string; screenId: string }> {
    // 1. ensureComputer for botId
    // 2. Look up computer_screens for (botId, userId) or create new screen
    // 3. ensureScreen() if not recently set up
    // 4. Return { computerId: botId, screenId }
  }

  async bash(botId: string, command: string, timeoutSec = 60, screenId?: string | null) {
    const containerId = await this.getContainerId(botId);
    const display = screenId ? `:${screenId.replace('screen-', '')}` : ':1';
    return execInContainer(containerId, ['bash', '-c', `export DISPLAY=${display}; ${command}`], {}, timeoutSec * 1000);
  }

  async writeFile(botId: string, file: string, content: string | Buffer) {
    const containerId = await this.getContainerId(botId);
    // Write to a temp file on host (in homePath), then it's visible inside the container
    // OR: pipe via `docker exec -i cat > file`
  }

  async vncConnect(botId: string, screenId: string): Promise<WebSocket> {
    const screen = await this.getScreen(botId, screenId);
    return new WebSocket(`ws://127.0.0.1:${screen.vncPort}`);
  }

  async takeControl(botId: string, screenId: string) {
    // Set computer_screens.control_token = null (enable input forwarding)
    // VNC relay in vnc.ts checks this flag: if no control_token, bot input blocked
    // Notify bot engine to pause computer actions
  }

  async giveControl(botId: string, screenId: string) {
    // Set computer_screens.control_token to a fresh token
    // VNC relay blocks human input again
    // Notify bot engine to resume
  }

  async suspend(botId: string) {
    // 1. checkpointWorkspace
    // 2. stopContainer
    // 3. Update state to 'suspended'
  }

  async destroy(botId: string, opts) {
    // 1. If running: stopContainer
    // 2. removeContainer
    // 3. If wipeWorkspace: rm homePath + checkpoint tarball
    // 4. Delete from computers + computer_screens tables
  }
}
```

---

## Phase 6 — Adapt `vnc.ts` for Docker

The existing `vnc.ts` relay already has `watch` / `control` mode and the full RFB handshake. Extend it:

### 6.1 Abstract the upstream connection

Currently hardcoded to Orgo websockify. Extract to:

```ts
interface VncUpstream {
  connect(botId: string, screenId: string, mode: 'watch' | 'control'): Promise<WebSocket>;
  password(botId: string): Promise<string>;
}
```

**OrgoVncUpstream:** existing logic (Orgo websockify URL + password)  
**DockerVncUpstream:**
- Connect to `ws://127.0.0.1:{vncPort}` (container's x11vnc listening on host)
- Password: `viewToken` stored in `computer_screens` table
- Control mode: check `control_token` — if null (human has taken over), forward all client input; if set, apply the existing `WatchFilter` to block bot input (or vice versa)

### 6.2 Control handoff protocol

The VNC relay currently just filters client→server messages (watch mode drops KeyEvent/PointerEvent). For the take-control feature:

```
Human takes control:
  POST /api/bots/:botId/screen/control  { action: 'take' }
  → sets control_token = null in DB
  → signals running VNC relay (via EventEmitter or in-memory state) to unfilter client messages
  → notifies bot engine to pause computer-action tool calls

Human gives control back:
  POST /api/bots/:botId/screen/control  { action: 'give' }
  → sets control_token = fresh UUID
  → signals relay to re-apply WatchFilter
  → notifies bot engine to resume
```

No new WebSocket protocol needed — the relay reads DB state at connection time and re-reads on the control endpoint call.

### 6.3 Route change in `routes.ts`

Currently `GET /api/bots/:id/screen` websocket upgrade → `relay()` in `vnc.ts`. Add:

```
POST /api/bots/:id/screen/control   { action: 'take' | 'give' }
```

---

## Phase 7 — `desk.ts` / screen dressing for Docker

`desk.ts` currently calls `box.bash` / `box.writeFile` from the global singleton. The dressing system (Python scripts, wallpaper SVG, Chrome extension, dock) is designed to run on the computer.

### 7.1 Pass box instance into desk functions

```ts
// desk.ts signature changes:
export function dressScreen(bot: DeskBot, screenId: string, box: Box, opts?): Promise<void>
export function resetScreen(bot: DeskBot, screenId: string, box: Box, opts?): Promise<void>
export function undressScreen(botId: string, screenId: string, box: Box): Promise<void>
```

Where `Box` is the interface from `box.ts`:
```ts
export interface Box {
  bash(command: string, timeoutSec?: number, screenId?: string | null): Promise<BashResult>;
  writeFile(file: string, content: string | Buffer, mode?: string): Promise<void>;
  readFile(file: string): Promise<Buffer | null>;
  quote(s: string): string;
}
```

The existing global `box` object satisfies this interface. Docker bots get a `dockerBox(containerId)` instance.

### 7.2 Docker box implementation

```ts
// server/src/docker/docker-box.ts
export function dockerBox(containerId: string): Box {
  return {
    async bash(command, timeoutSec = 60, screenId) {
      const display = screenId ? `:${Number(screenId.replace('screen-', ''))+1}` : ':1';
      const env = { DISPLAY: display, HOME: '/home/bot', PATH: '...' };
      return execInContainer(containerId, ['bash', '-c', command], env, timeoutSec * 1000);
    },
    async writeFile(file, content, mode = '0644') {
      // Stream content via `docker exec -i sh -c 'cat > <file>'`
      // Then chmod if needed
    },
    async readFile(file) {
      const r = await execInContainer(containerId, ['bash', '-c',
        `[ -f '${file}' ] && base64 -w0 '${file}' || echo __missing__`], {}, 10000);
      if (r.stdout.trim().endsWith('__missing__')) return null;
      return Buffer.from(r.stdout.trim(), 'base64');
    },
    quote: q,
  };
}
```

### 7.3 Callers to update

- `readyScreen()` in `computer.ts` / `OrgoComputerProvider` → pass global `box`
- `DockerComputerProvider.readyScreen()` → pass `dockerBox(containerId)`
- `dressScreen()` calls in routes → route through provider

---

## Phase 8 — Bot provisioning flow

When a new managed bot is created (or first opened):

```
1. INSERT INTO computers (bot_id, kind='docker', state='stopped', home_path=homeDirFor(botId))
2. User opens bot screen / bot receives a task
3. DockerComputerProvider.ensureComputer(botId):
   a. mkdir homeDirFor(botId)
   b. restoreWorkspace(botId, homePath)  — no-op if first time
   c. createBotContainer({ botId, homePath })
   d. UPDATE computers SET state='booting'
   e. resetScreens(containerId)          — clear stale X11 state
   f. UPDATE computers SET state='running', container_id=containerId
4. DockerComputerProvider.screenFor(userId, botId):
   a. allocate display index (1 for first screen)
   b. viewToken = randomUUID()
   c. INSERT INTO computer_screens (...)
   d. ensureScreen(containerId, index, botId, viewToken)
5. DockerComputerProvider.readyScreen(userId, botId):
   a. dressScreen(bot, screenId, dockerBox(containerId))  — installs /opt/hq scripts, wallpaper, Chrome
```

---

## Phase 9 — Suspension / shutdown

**On graceful shutdown** (SIGTERM / server restart):
```
For each running Docker computer:
  1. checkpointWorkspace(botId, homePath)
  2. stopContainer(containerId)
  3. UPDATE computers SET state='suspended'
```

**On server startup:**
```
For each computer WHERE state IN ('booting','running'):
  → State is stale from crash: set state='stopped'
  → Container may still be running: stopContainer if found, then set suspended
```

**Idle timeout** (configurable, default 30 min no VNC viewer):
- Existing `idle.ts` calls `viewerOpened/viewerClosed` — extend to trigger `suspend(botId)` after idle timeout
- On next activity: `ensureComputer` resumes from suspended state (restoreWorkspace + start)

---

## Phase 10 — Configuration

New env vars (add to `.env` and `env.ts`):

```
# Docker computer provider
COMPUTER_KIND=docker              # 'orgo' | 'docker' | 'auto' (auto=docker if PRIMARY_BOT else orgo)
COMPUTER_IMAGE=ghcr.io/rakazo/computer:latest   # Docker image for bot containers
COMPUTER_IDLE_TIMEOUT_MIN=30      # Minutes before auto-suspend
COMPUTER_CPU_LIMIT=2              # CPU shares per container
COMPUTER_MEMORY_LIMIT=2g          # Memory limit per container
DOCKER_SOCKET=/var/run/docker.sock
```

---

## Implementation order

| Step | File(s) | Effort |
|------|---------|--------|
| 1 | Define `ComputerProvider` interface + `Box` interface | Small |
| 2 | Schema migration (`computers`, `computer_screens` tables) | Small |
| 3 | `docker/container.ts` — container create/start/stop/remove | Medium |
| 4 | `docker/exec.ts` — exec in container | Small |
| 5 | `docker/workspace.ts` — checkpoint/restore | Small |
| 6 | `docker/screen.ts` — X11/VNC screen management | Medium |
| 7 | `docker/docker-box.ts` — Box impl via exec | Small |
| 8 | `DockerComputerProvider` — full provider impl | Medium |
| 9 | Refactor `desk.ts` to accept Box parameter | Small |
| 10 | Refactor `OrgoComputerProvider` from `computer.ts` | Small |
| 11 | `vnc.ts` — add Docker VNC upstream path | Medium |
| 12 | Control take/give endpoints + DB flag | Small |
| 13 | Startup/shutdown lifecycle hooks | Small |
| 14 | Wire providers into bot creation flow | Small |

**Total: ~2–3 days of focused work**

---

## Files to create

```
server/src/
├── computer-provider.ts          (interface + registry)
├── docker-provider.ts            (DockerComputerProvider)
└── docker/
    ├── container.ts
    ├── exec.ts
    ├── workspace.ts
    ├── screen.ts
    └── docker-box.ts
```

## Files to modify

```
server/src/
├── box.ts                 (add Box interface, dockerBox factory)
├── computer.ts            (wrap in OrgoComputerProvider)
├── desk.ts                (accept Box param in exported fns)
├── vnc.ts                 (add Docker upstream path)
├── routes.ts              (add control take/give endpoint)
├── db-config.ts           (add computers + computer_screens migration)
└── env.ts                 (add COMPUTER_KIND, COMPUTER_IMAGE, etc.)
```

## New npm dependency

```
dockerode        (Docker Engine API client)
@types/dockerode (types)
```

Rakazo already uses `dockerode` in `third-party/rakazo/` — same package, no new risk.

---

## Open questions / decisions deferred

1. **Docker image** — Use Rakazo's `ghcr.io/rakazo/computer` image directly, or build a leaner orbit-specific image? Rakazo's image already has X11, VNC, Chromium, Python3, xdotool — everything `desk.ts` needs. Recommendation: use it as-is to start.

2. **noVNC vs raw VNC** — The existing `vnc.ts` relay does raw RFB over WebSocket (the browser side uses noVNC's JS client). No change needed there for Docker; x11vnc in the container is a standard RFB server.

3. **Network isolation** — Containers default to `network=none` for security. If a bot needs internet access, add per-bot network config. Start locked down.

4. **Primary bot** — The primary bot stays on Orgo (or `HQ_LOCAL=1`). The `COMPUTER_KIND=auto` default provisions Docker only for managed bots, keeping the primary bot on its current path.
