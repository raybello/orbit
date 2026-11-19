# Per-Bot computers

Every managed Bot can have its own computer. The primary Bot keeps the shared Orgo computer (or
this machine with `HQ_LOCAL=1`), because that is somebody's live desktop.

## How it fits together

- `ComputerProvider` (`server/src/computer-provider.ts`) is what the rest of the server uses:
  ensure, screen, bash, files, DevTools address, VNC upstream, control, screenshot, suspend, destroy.
- `OrgoComputerProvider` (`server/src/computer.ts`) wraps the existing Orgo behaviour unchanged.
- `DockerComputerProvider` (`server/src/docker-provider.ts`) runs one container per Bot.
- `computer-provider-registry.ts` picks the provider. A Bot's choice is written to `bot_computers`
  when the Bot is created and never changes.
- `desk.ts` dresses the screen through a `Box`, so the same wallpaper/dock/Chrome scripts run on
  Orgo or inside a container (`docker/docker-box.ts`).

## A container

- Image: `COMPUTER_IMAGE` (default `orbit/computer:local`). Unqualified names are built locally from
  `server/docker/computer`; registry names are pulled.
- `/home/bot` is bind-mounted from `COMPUTER_HOME_DIR/homes/<botId>`, so Chrome logins, files and
  desk state live on the host and survive a stop. Checkpoints of that folder are written to
  `COMPUTER_HOME_DIR/workspaces/<botId>.tar.gz` on suspend.
- One screen per container: Xvfb on `:<display>`, fluxbox, and TigerVNC's `x0vncserver` on
  `5900 + display` (started with `-localhost=no`; the host still publishes the port on `127.0.0.1`
  only). Display indexes are unique across all Bots, so VNC (`59xx`) and DevTools (`92xx`) ports
  never collide.
- Viewer keystrokes are applied with `xdotool` inside the container rather than forwarded to the VNC
  server: neither x11vnc nor x0vncserver gets synthetic keys into X in this image, while pointer
  events do go through. `vnc.ts` splits key events out of the client stream and calls
  `DockerComputerProvider.pressKey`.
- Chrome binds DevTools to the container's loopback, so `socat` listens on the container's interface
  (`93xx`) and the host publishes that as `92xx` on `127.0.0.1`.

## Lifecycle

- Created on the first screen open or turn; `bot_computers.state` goes `stopped → booting → running`.
- Frozen (`docker pause`) after `COMPUTER_PAUSE_AFTER_MIN` minutes with no viewer and no turn: no
  CPU, memory kept, and the next screen open or turn thaws it in a fraction of a second. Screenshots
  of a frozen bot are skipped rather than waking it.
- Suspended after `COMPUTER_IDLE_TIMEOUT_MIN` minutes with no viewer and no turn: checkpoint the home
  folder, stop the container. The next open starts it again and re-dresses the screen.
- Before a container starts, the provider checks that Docker's machine has room for one more bot at
  `COMPUTER_MEMORY_RESERVATION`. If not, the bot idle the longest (frozen ones first, never one being
  watched or working) is suspended to make room. With nothing to give way, the start fails with a
  message saying so, rather than the kernel killing some bot's browser later.
- On server shutdown (SIGTERM/SIGINT) every running container is checkpointed and stopped; on startup
  anything left `running` is stopped before it is trusted.
- Deleting a Bot removes its container and wipes its home folder.

## Configuration

```
COMPUTER_KIND=docker              # 'orgo' | 'docker' | 'auto' (primary Bot always stays on Orgo)
COMPUTER_IMAGE=orbit/computer:local
COMPUTER_HOME_DIR=./data/computers
COMPUTER_PAUSE_AFTER_MIN=5        # freeze an idle bot; 0 = never
COMPUTER_IDLE_TIMEOUT_MIN=30      # checkpoint and stop it
COMPUTER_CPU_LIMIT=1
COMPUTER_MEMORY_LIMIT=900m        # hard cap per bot
COMPUTER_MEMORY_RESERVATION=600m  # soft limit, and what a bot counts for in the room check; 0 = off
MAX_BOTS=10                       # 4 by default with COMPUTER_KIND=orgo
COMPUTER_NETWORK=bridge
COMPUTER_MAX_DISPLAYS=50
DOCKER_SOCKET=/var/run/docker.sock   # empty = DOCKER_HOST, else Docker's default
```

On Docker Desktop or colima, `COMPUTER_HOME_DIR` must be under a shared path (your home directory).

## Sizing: ten bots on a 16 GB machine

Chromium is nearly all of a bot computer's cost: the desktop itself (Xvfb, fluxbox, VNC) is about
40 MB. Inside a container, `box/hqlib.py` starts Chrome lean (`HQ_LEAN_BROWSER`, on by default in a
container): two renderer processes at most, no GPU process, fewer background services, a capped JS
heap, tab discarding. The screen is 1280×800.

Measured on an M1 Pro (16 GB) with colima at 10 GB / 6 CPUs, ten bots booted through the real
provider (`scripts/density-test.ts`), each with two real pages open and three with four:

| | per bot | ten bots |
|---|---|---|
| Desk up, home page only | ~290 MB | 2.9 GB |
| Working (2–4 pages) | ~540 MB, max ~750 MB | 5.4 GB, 4.0 GB of the VM still free |

The two bots that had YouTube and three other heavy pages open hit their 900 MB cap once each. Chrome
killed one of their tabs and kept running. Idle pages still use CPU (one to three of the six cores
across all ten), which is what the idle pause removes.

For a Mac with 16 GB, give the Docker VM 10 GB and 6 CPUs (`colima start --memory 10 --cpu 6`, or
Docker Desktop's resources page) and leave the rest for macOS. On a 16 GB Linux host there is no VM,
and the same limits leave more headroom. With 8 GB for Docker, the room check fits twelve bots at
600 MB, but working bots will feel tight. Keep `MAX_BOTS` lower there.

## Controlling a screen

`POST /api/bots/:id/screen/control` with `{"action":"take"}` or `{"action":"give"}`. A browser
connected with `?mode=control` holds the lease itself: the relay grants control on connect and hands
it back when the last control viewer closes.

## How a Bot uses its computer

Hermes' own `computer_use` toolset acts on the display of the process running the agent, which is
never a container (and on macOS there is no X server at all), so the app gives every Bot computer
tools of its own (`server/src/computer-tools.ts`), executed through the `ComputerProvider`:

`computer_windows`, `computer_screenshot` (saved into the Library), `computer_click`,
`computer_drag`, `computer_type`, `computer_key`, `computer_scroll`, `computer_shell`.

They work the same on the shared Orgo computer and inside a container, and the Bot's browser is
still driven over CDP (`browser.cdp_url`).

## Model

Every new Bot, the primary included, runs `DEFAULT_BOT_PROVIDER` / `DEFAULT_BOT_MODEL` (default:
`anthropic` / `claude-sonnet-4-5`) unless a model is picked when it is created: in the Create Bot
dialog, or by the primary Bot, which reads the connected providers with `list_models` and passes
`provider` and `model` to `create_bot`. The choice is stored on the Bot and written into its
`config.yaml` `model` block each time its home is written, with the provider's `base_url` and
`api_mode` when the config defines that provider (a custom endpoint such as a local model server).

Managed Bots still take their credentials from the primary agent: model keys from its `.env`, and an
Anthropic subscription sign-in as an access token.

## Not done yet

- One screen per container. A second screen would need a new container (ports are fixed at create).
- The Library (`save_file`, `show_file`) still writes to the server's own files folder, not to the
  Bot's container.

## When the server itself runs in a container

The desktop app ships the server as a Docker image, so the server is not on the host; it is a
sibling of the bot containers. Three things follow from that, and each one was a real outage:

- **The relay dials the bot, not the host.** A bot's VNC (5901) and DevTools (9300+display) ports
  are only published on the host's loopback for a host-run server. Inside a container,
  `127.0.0.1` is the server itself, so the screen resolver (`docker/reach.ts`) joins the bot's
  container to the network the server is on and dials its container address. Bot containers are
  therefore created **without host port bindings** when the server is containerized — publishing
  them only invites `Bind for 127.0.0.1:<port> failed: port is already allocated` when a second
  stack (or an older bot) already holds that port.
- **The api container runs as root.** The mounted Docker socket is `root:docker` inside Docker
  Desktop's VM and its group id changes between installs, so a non-root user gets `EACCES` on
  every Docker call — which the app reports as "couldn't reach the screen". Access to that socket
  is already equivalent to host root; the compose files say `user: "0:0"` and explain it.
  Because of that, `HERMES_ALLOW_ROOT_GATEWAY=1` is passed to the bundled gateway (it refuses root
  otherwise), and `HERMES_ALLOW_ROOT_GATEWAY` is the one Hermes variable forwarded to a spawned
  gateway.
- **`COMPUTER_IMAGE` must never be empty.** An empty value used to reach the Docker client as an
  empty reference, which it mangled into a request for a host named `images`
  (`EAI_AGAIN images`, or an HTTP 301) and aborted the boot path. The compose files default it to
  `orbit/computer:local`, `env.ts` treats an empty value as unset, and `docker/image.ts` refuses
  an empty reference with a clear message.

`POST /api/computer/ensure` follows the same split: it wakes the Orgo machine when there is one,
and otherwise creates/starts the bot containers. It previously asked Orgo unconditionally, which
returned 500 in a Docker stack and left the viewer's Retry button broken.
