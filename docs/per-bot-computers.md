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

Managed Bots start on `DEFAULT_BOT_MODEL` / `DEFAULT_BOT_PROVIDER` (default: `deepseek-flash` /
`deepseek`). The DeepSeek key is inherited from the primary agent's `~/.hermes/.env`
(`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`).

## Not done yet

- One screen per container. A second screen would need a new container (ports are fixed at create).
- The Library (`save_file`, `show_file`) still writes to the server's own files folder, not to the
  Bot's container.
