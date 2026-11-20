# Architecture

A web app (`apps/web/`) and a Node server (`apps/server/`) sit in front of Hermes agents, wrapped by an Electron desktop app (`apps/desktop/`) and an Expo mobile app (`apps/mobile/`). Hermes owns each Bot's agent loop, history, memory and model. The server adds the things Hermes does not have: the chat interface, a computer for each Bot (a Docker container of its own), connected apps with approvals, routines, the Library, and voice.

```text
browser ── HTTP + SSE ──► server ── POST /v1/responses ──► Hermes gateway (one per Bot)
   │                        ▲                                   │
   └── WebSocket (VNC) ─────┤◄──────── MCP: POST /mcp/<bot> ────┘
                            └── Bot computers: a container per Bot
```

## Components

| Piece | Where | What it does |
|---|---|---|
| API + realtime | `server/src/routes*.ts`, `lib/hub.ts` | JSON over HTTP, plus one Server-Sent Events stream per user (`GET /api/events`) carrying row updates, live state, roster changes and computer state |
| Turns | `server/src/agent/loop.ts` | Per-Bot serial queue. A turn posts the message to the Bot's Hermes gateway (`/v1/responses`, streaming) and turns the event stream into rows (messages, tool calls) and live state (what the Bot is doing now). Before each turn it makes sure the Bot's screen is ready |
| Engines | `server/src/engine.ts` | Which Hermes runs which Bot. The **primary** engine is the gateway that already runs on the computer; the app only calls its API. A **managed** engine is a Hermes home under `ENGINES_DIR/<botId>` with its own `hermes gateway run`, its own port (from 8650), credentials, model and browser helper (`BH_HOME`). Also: model and provider settings, and opening Hermes' subscription sign-in in a terminal on the Bot's screen |
| App tools | `server/src/mcp.ts`, `agent/tools.ts` | An MCP endpoint per Bot (`POST /mcp/<botId>`, `POST /mcp/primary`; bearer token derived from `SESSION_SECRET`). Tools: `x_search`, `save_file`, routines, tasks, check-ins, `calendar_list`, `send_to_bot`, group chats, `ask_user`, `request_app_connection`, plus the user's Composio tools. `agent/prompt.ts` states each Bot's core capabilities and, per connected Google app, a short action sheet (`agent/app-sheets.ts`) checked against Composio's schemas |
| Memory | `server/src/engine-memory.ts` | Memory lives in each Bot's Hermes home (`memories/MEMORY.md`, `USER.md`). The app shows the entries and lets the user remove one |
| Computers | `server/src/computer-provider.ts`, `computer-provider-registry.ts`, `computer.ts`, `docker-provider.ts`, `docker/*` | `ComputerProvider` is the only way the rest of the server reaches a Bot's computer. `DockerComputerProvider` gives every Bot its own container (Xvfb + x11vnc + Chrome, `/home/bot` bind-mounted from `COMPUTER_HOME_DIR/homes/<botId>`), and suspends it after an idle timeout. `computer.ts` reports the computers' state to the app; see `docs/per-bot-computers.md` |
| Screens | `server/src/desk.ts`, `box.ts`, `server/box/*` | `desk.ts` installs the scripts in `server/box/` under `/opt/hq` and calls them through a `Box` to dress a screen: wallpaper, dock, light theme, a Chrome with its own profile and DevTools port (9200 + display number), and a home screen as the new tab page. `box.ts` runs the server's own commands, and `docker/docker-box.ts` runs a Bot's inside its container |
| Viewer | `server/src/vnc.ts` | WebSocket relay between the browser (noVNC) and the screen's VNC server, over a container's x11vnc port. The server does the VNC auth, so the computer's password never reaches the browser. In *watch* mode, keyboard, pointer and clipboard messages are dropped on the server; a control viewer may type |
| Apps | `server/src/composio.ts`, `triggers.ts` | Catalog, per-user sessions, connect links, tool execution, and triggers for event routines. Sign-in uses a Composio-managed Google connection. The server's own Google calls (`runAction`) are pinned to one toolkit version |
| Review cards | `server/src/review/*`, `domain/google-actions.ts` | What each Gmail, Calendar, Sheets and Docs action is (read, runs at once, or reviewed), and for reviewed ones how the approval card shows it and applies the person's edits. Drafts (`review/drafts.ts`) and created or changed files (`review/files.ts`) appear in the chat |
| Calendar | `server/src/calendar/*`, `routes-calendar.ts` | The encrypted Google Calendar mirror and its sync, the person's own Google event changes from Orbit, and Orbit events made from Google events (`calendar/links.ts`) |
| Scheduling | `server/src/routines.ts`, `proactive.ts` | Cron routines, event routines, and check-ins for the primary Bot. Each run is a turn |
| Voice | `server/src/voice.ts`, `web/src/voice/*` | Mints short-lived xAI realtime client secrets; the browser connects to xAI directly. The voice agent hands real work to the Bot's turn queue and speaks the result. Also proxies TTS previews and dictation |
| UI | `web/src` | React + zustand. Sidebar, chat with a "thinking" chip that follows the Bot's activity, details panel (screen preview, activity, tasks, Library, engine), settings, viewer, voice call bar |

## The primary engine

The first Bot is bound to a Hermes gateway the app did not start. The rules:

- The app never restarts it, stops it, or writes its `config.yaml`.
- Its other sessions (iMessage, Telegram, cron) see the same tools. When one of those sessions calls a tool that needs approval, the card shows up in the app.

## Screens and browsers

Each Bot's Chrome is started by the app on that Bot's screen and its Hermes config points at that Chrome's DevTools port, so browsing is visible in the viewer. Two details matter:

- Hermes' browser tool finds its helper process under `BH_HOME`. Every managed gateway gets its own, otherwise all agents on the computer would drive one browser.
- A screen is dressed before the Bot's first turn (`dockerProvider.readyScreen`), so the agent never finds an empty screen and starts a stray browser.

Hermes can also run a private "Bot Desktop" for an agent. While it is on, that agent's desktop work happens there and not on the screen the app shows; the engine panel reports this and offers a button to switch it off.

## Transcript model

A conversation is an append-mostly list of **rows**: `seq` (position), `updatedSeq` (a per-Bot revision counter), `kind` and a JSON `body`. A streaming reply is the same row rewritten with a higher `updatedSeq`, so clients upsert by `seq`. A per-Bot `generation` counter starts a new conversation (and a new Hermes session).

Row kinds: `message` (user or assistant, optionally from another Bot or a voice call), `tool-call` (shown as an activity line and a collapsible step list), `card` (approval, question, connect, draft), `event`, `notice`.

The model's own history is Hermes' business; the app keeps only what it shows.

## Approvals

Approvals happen inside the MCP call, so they work the same for every engine:

- Composio actions that only read run at once. For Gmail, Calendar, Sheets and Docs an explicit catalogue (`domain/google-actions.ts`) decides instead of the action's name: writing an email draft and creating a new sheet or doc also run at once.
- Anything else posts an **approval card** and the tool call waits. **Allow** runs it once, **Always allow** stores a per-tool policy, **Don't allow** returns a refusal that tells the agent not to retry.
- Sending email always asks: a stored "Always allow" does not cover it and the card does not offer it, unless the person turned on **per-bot Always allow** for that Bot (`bots.always_allow`), in which case "Always allow for <Bot>" is kept for that Bot only (`bot_policies`).
- For a Google action the card shows what will happen (the email, the event and what it was, the cells before and after, the text) and the person may edit it before allowing. What runs is their version, checked by the action's review adapter; the result tells the Bot what changed. A batch call gets one card per action that asks. Every calendar change runs as a patch, so a Bot's `UPDATE_EVENT` cannot drop guests.
- A new user message, or no answer in time, closes the card and the call returns "skipped". Editing keeps the call waiting, up to two hours.

Not covered: what a Bot does through its browser or shell, and Hermes' own prompts for risky commands.

## Bots working together

- **`send_to_bot`** delivers a message to another Bot's queue; the reply comes back the same way.
- **Group chats** are a Bot row with `kind='room'` and a member list. A user message goes to the @mentioned members, or to all of them (up to 3).
- For work inside one task, Hermes' own delegation is used.

## Data

SQLite (`DB_PATH`, WAL): users and sessions, Bots, rows, approvals and policies (and per-bot policies), routines, tasks, the shared skill library, screen leases, per-Bot computers and their screens, Composio session ids, and the Google Calendar mirror. Each managed Bot's Hermes home is under `ENGINES_DIR`. On the computer: Chrome profiles in `/root/grokbot/profiles/<botId>`, Library files in `/root/grokbot/files/<botId>`. Deleting a Bot removes its gateway, home, profile, files and screen.

The Google Calendar mirror (`gcal_calendars`, `gcal_events`) and the snapshot an Orbit event keeps of the Google event it was made from (`routines.parent_sealed`) are encrypted with `DB_ENCRYPTION_KEY` (AES-256-GCM, bound to their row); rows are found by HMAC keys, so only times and flags are stored readable. Without the key the mirror is off.

Secrets live in `.env` on the server and in each Hermes home.

## External services

| Service | Used for |
|---|---|
| Hermes Agent | The agent loop, tools, memory and model access for every Bot (API keys or subscription sign-ins) |
| Composio | Sign-in, connectors, triggers |
| xAI | Research on X (`x_search`), realtime voice, TTS, dictation |

## Monorepo and clients

The repo is a pnpm workspace driven by Turbo: `apps/{server,web,desktop,mobile}` and
`packages/{contracts,ui-tokens,logger}`. `pnpm dev` builds the packages and runs the
server and web dev servers; `pnpm typecheck`, `pnpm build`, `pnpm --filter @orbit/desktop run test`
and `pnpm smoke` (an end-to-end server API check) are the gates CI runs.

| Piece | Where | What it does |
|---|---|---|
| Contract | `packages/contracts` | Every type shared by clients and server (`Bot`, `Row`, `ServerEvent`, `HealthResponse`, `DesktopConfigResponse`, `SignInResponse`, `PushPayload`). Type-only: no runtime dependency. |
| Tokens | `packages/ui-tokens` | `tokens.css` (the web/desktop palette) plus the same values as typed constants for React Native and the native windows |
| Desktop | `apps/desktop` | Electron shell. Loads the web build as its renderer; first-run window picks "this computer" (Docker Compose stack, or a supervised native stack on Apple-silicon macOS 26+) or an existing server; menu for switching server and stack; `electron-updater` against GitHub Releases |
| Local stack | `apps/desktop/src/local-stack.ts` | Generates the stack `.env` secrets, picks a free loopback port, runs `docker compose pull/up`, polls `/api/health` with `x-orbit-stack-token` |
| Native stack | `apps/desktop/src/native-stack.ts` | On eligible Macs: downloads a checksummed server bundle, runs migrations and the API as supervised `ELECTRON_RUN_AS_NODE` processes, keeps ports stable in `.native-ports` |
| Mobile | `apps/mobile` | Expo Router client for any Orbit server: chat, approvals, bot roster, live screen (noVNC in a WebView), Expo push. Session token in `expo-secure-store`, bearer auth |
| Infra | `infra/compose`, `apps/server/Dockerfile` | The image-based stack the desktop app bundles, and the source-build stack for development; images publish to GHCR from `main` and `v*` tags |

Clients authenticate with the session cookie (web, desktop renderer) or
`Authorization: Bearer <session token>` (mobile, native UI). `POST /api/auth/sign-in`
mints that token from the server's owner key (or from an email alone when `DEV_LOGIN=1`).
SSE carries a `seq` and accepts `?since=` so a client that was backgrounded can replay
what it missed; when no SSE connection is open for a user, the server pushes to their
registered Expo tokens instead.
