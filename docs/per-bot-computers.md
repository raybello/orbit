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
- Suspended after `COMPUTER_IDLE_TIMEOUT_MIN` minutes with no viewer and no turn: checkpoint the home
  folder, stop the container. The next open starts it again and re-dresses the screen.
- On server shutdown (SIGTERM/SIGINT) every running container is checkpointed and stopped; on startup
  anything left `running` is stopped before it is trusted.
- Deleting a Bot removes its container and wipes its home folder.

## Configuration

```
COMPUTER_KIND=docker              # 'orgo' | 'docker' | 'auto' (primary Bot always stays on Orgo)
COMPUTER_IMAGE=orbit/computer:local
COMPUTER_HOME_DIR=./data/computers
COMPUTER_IDLE_TIMEOUT_MIN=30
COMPUTER_CPU_LIMIT=2
COMPUTER_MEMORY_LIMIT=2g
COMPUTER_NETWORK=bridge
COMPUTER_MAX_DISPLAYS=50
DOCKER_SOCKET=/var/run/docker.sock   # empty = DOCKER_HOST, else Docker's default
```

On Docker Desktop or colima, `COMPUTER_HOME_DIR` must be under a shared path (your home directory).

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

Managed Bots start on the primary agent's model and credentials (the bot's home is written from the
primary's config, and an Anthropic subscription sign-in is inherited as an access token). They fall
back to `DEFAULT_BOT_MODEL` / `DEFAULT_BOT_PROVIDER` (default: `deepseek-flash` /
`deepseek`). The DeepSeek key is inherited from the primary agent's `~/.hermes/.env`
(`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`).

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
