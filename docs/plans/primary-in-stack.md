# Primary agent in the stack

## Goal

Orbit runs every agent, the primary included, so a person never needs Hermes installed on their
machine for the Docker stack. Today the nine managed bots run as `hermes gateway run` processes the
server starts (`apps/server/src/engine.ts`). Only the primary runs elsewhere: on the host, reached
over `HERMES_URL`, with `~/.hermes` mounted into the container and its config rewritten by
`engine-hq.ts`. That split caused the HQ 401s (a containerized server cannot signal a host
gateway), the host-vs-container URL fixes, the hq lease, and the desktop installer.

## Done when

- A clean Docker stack (no `~/.hermes` mount, no `HERMES_URL`) starts a primary gateway itself, and
  the primary bot answers a chat turn.
- The primary has HQ tools: it creates a bot with `create_bot`, messages it with `send_to_bot`, and
  gets a reply.
- Composio connectors still list and Connect still returns an auth link.
- With a `~/.hermes` present, the first stack start imports its model keys, model config, SOUL.md,
  memories and skills into the primary's home once, and never touches `~/.hermes` again.
- `node scripts/check-import-cycles.mjs`, typecheck, the server and desktop suites, and
  `node scripts/smoke-server.mjs` pass.

## Data shape

One engine record per agent, the same for primary and managed:

| field | primary | managed |
| --- | --- | --- |
| home | `env.primaryHome` = `<ENGINES_DIR>/primary` (stable across bot ids) | `<ENGINES_DIR>/<botId>` |
| port | `env.primaryEnginePort` (default 8642), loopback | `bots.engine_port` |
| key | `API_SERVER_KEY` in its own `.env` | same |
| hq | `http://127.0.0.1:<PORT>/mcp/primary` (stable across bot ids) | `http://127.0.0.1:<PORT>/mcp/<botId>` |
| credentials | its own (import, then in-app engine login) | inherited from the primary's home (unchanged) |

The primary stays `engine='primary'`: managed bots still inherit from it. What changes is who runs
it: the server, in every mode (Docker, native stack, `pnpm dev`).

## Decisions

- **Every mode, not only Docker.** Running the primary everywhere the server runs deletes the
  external-primary path entirely (`HERMES_URL`, `HERMES_KEY`, `engine-hq.ts`, the hq lease). The
  native stack and `pnpm dev` already need a host `hermes` binary for the managed bots, so they
  keep that requirement, and they no longer share `~/.hermes` with the person's own Hermes app.
- **Import copies the subscription sign-ins too.** Model keys (`SHARED_ENV` only, never messaging
  tokens such as Telegram or Discord, which would make two agents answer one bot), the
  `SHARED_CONFIG` blocks minus `mcp_servers`, `SOUL.md`, `memories/`, `skills/`, `auth.json` and the
  OAuth singleton file. The primary reaches the person's Claude or ChatGPT subscription from its
  first turn. Hermes refresh tokens are single-use, so whichever copy refreshes first can leave the
  person's own Hermes app needing to sign in again.
- **Import runs once.** A marker file in the primary's home records it. In Docker the desktop app
  runs it as a one-shot container (`~/.hermes` mounted read-only only for that run) before
  `compose up`, so the stack itself mounts nothing from the host.
- **The desktop Hermes installer stays only for the native stack**, which runs the server on the
  host and needs a host `hermes` binary. The Docker path no longer calls it.
